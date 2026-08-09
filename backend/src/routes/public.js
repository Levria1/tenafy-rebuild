const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const inquiryExtractor = require('../services/inquiryExtractor');
const { searchUnits } = require('../services/unitSearch');
const { getMasterPool } = require('../config/poolRegistry');
const { KIND_INVITE } = require('../middleware/viewingTokenAuth');
const { mintInvite } = require('../services/viewingInvite');
const { createCandidateBooking, findActiveLeaseForUnit } = require('../services/viewingBooking');
const viewingNegotiation = require('../services/viewingNegotiation');
const { loadTemplate, substituteVariables } = require('../services/emailService');
const { validateBookingSlot } = require('../utils/viewingWindow');
const {
  hkDate,
  appendFactsToNotes,
  resolveWritableFields,
  mergeApiSetFields,
  validateFields,
  payloadHash,
} = require('../utils/inquiryFacts');
const config = require('../config');

// All public routes require a valid API key (see middleware/apiKeyAuth.js).
// The middleware attaches req.pool (scoped to the caller's org DB) and
// req.apiKey.{id, orgId, name}. Every query below filters by req.apiKey.orgId
// AND runs against req.pool, so multi-tenant isolation is enforced in two places.
router.use(authenticateApiKey);

// Helper: consistent JSON response
function ok(res, data, meta) {
  res.json({ code: 200, data, meta: { total: Array.isArray(data) ? data.length : undefined, ...(meta || {}) } });
}
function fail(res, message, status = 500) {
  res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

const FACT_CHANNELS = new Set(['whatsapp', 'email']);
const MAX_FACTS = 50;
const MAX_FACT_CHARS = 500;
const MAX_NOTES_CHARS = 60000;
const INQUIRY_FACT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'budget', 'desired_start_date'];

function inquiryFactResponse({ inquiryId = null, created = false, applied = false, reason = null, supersededInquiryId = null }) {
  return {
    inquiry_id: inquiryId == null ? null : String(inquiryId),
    created,
    applied,
    reason,
    superseded_inquiry_id: supersededInquiryId == null ? null : String(supersededInquiryId),
  };
}

function validateInquiryFactRequest(body, { requireIsInquiry = false } = {}) {
  const b = body || {};
  for (const field of ['schema_version', 'channel', 'channel_user_id', 'occurred_at', 'idempotency_key']) {
    if (b[field] === undefined || b[field] === null || b[field] === '') {
      return { ok: false, error: `${field} is required` };
    }
  }
  if (requireIsInquiry && (b.is_inquiry === undefined || b.is_inquiry === null)) {
    return { ok: false, error: 'is_inquiry is required' };
  }
  if (b.schema_version !== 1) return { ok: false, error: 'unsupported_schema_version' };
  // occurred_at must PARSE, not merely be present: hkDate returns '' for garbage,
  // which would append note lines prefixed with a bare ": " and quietly destroy the
  // date on the audit trail Rule 4 exists to protect.
  if (!hkDate(b.occurred_at)) return { ok: false, error: 'invalid_occurred_at' };
  if (!FACT_CHANNELS.has(String(b.channel))) return { ok: false, error: 'unsupported_channel' };
  if (b.facts !== undefined && !Array.isArray(b.facts)) return { ok: false, error: 'facts_must_be_array' };
  const facts = Array.isArray(b.facts) ? b.facts : [];
  if (facts.length > MAX_FACTS) return { ok: false, error: 'too_many_facts' };
  for (const fact of facts) {
    if (String(fact).length > MAX_FACT_CHARS) return { ok: false, error: 'fact_too_long' };
  }
  const fieldsResult = validateFields(b.fields);
  if (!fieldsResult.ok) return { ok: false, error: fieldsResult.error };
  return { ok: true, facts, fields: fieldsResult.fields };
}

async function updateDeliveryOutcome(conn, orgId, idempotencyKey, outcome) {
  await conn.execute(
    `UPDATE inquiry_fact_delivery
        SET inquiry_id = ?, applied = ?, reason = ?
      WHERE org_id = ? AND idempotency_key = ?`,
    [
      outcome.inquiryId == null ? null : outcome.inquiryId,
      outcome.applied ? 1 : 0,
      outcome.reason || null,
      orgId,
      idempotencyKey,
    ]
  );
}

async function claimInquiryFactDelivery(conn, orgId, idempotencyKey, hash) {
  try {
    await conn.execute(
      `INSERT INTO inquiry_fact_delivery
         (id, org_id, idempotency_key, payload_hash, applied)
       VALUES (?, ?, ?, ?, 0)`,
      [newId(), orgId, idempotencyKey, hash]
    );
    return null;
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const [[prior]] = await conn.execute(
      `SELECT inquiry_id, applied, reason, payload_hash
         FROM inquiry_fact_delivery
        WHERE org_id = ? AND idempotency_key = ?
        LIMIT 1`,
      [orgId, idempotencyKey]
    );
    return prior;
  }
}

async function loadLockedInquiryForFacts(conn, orgId, inquiryId) {
  const [[row]] = await conn.execute(
    `SELECT i.id, i.status, i.tenant_id, i.notes, i.api_set_fields,
            i.first_name, i.last_name, i.email, i.phone, i.budget,
            DATE_FORMAT(i.desired_start_date, '%Y-%m-%d') AS desired_start_date,
            i.deleted_at
       FROM inquiry i
      WHERE i.id = ? AND i.org_id = ?
      FOR UPDATE`,
    [inquiryId, orgId]
  );
  if (!row) return { row: null, reason: 'no_inquiry' };
  if (row.deleted_at != null) return { row, reason: 'inquiry_deleted' };
  if (Number(row.status) !== 0) return { row, reason: 'inquiry_closed' };
  if (row.tenant_id != null) return { row, reason: 'inquiry_converted' };
  const [[active]] = await conn.execute(
    `SELECT EXISTS(
       SELECT 1
         FROM viewing_booking vb
         JOIN inquiry i ON i.id = vb.inquiry_id
        WHERE vb.inquiry_id = ? AND i.org_id = ? AND vb.status IN (1, 3)
        LIMIT 1
     ) AS active`,
    [inquiryId, orgId]
  );
  if (Number(active.active) === 1) return { row, reason: 'viewing_active' };
  return { row, reason: null };
}

function buildFieldAssignments(fields, currentRow) {
  const resolved = resolveWritableFields(fields, currentRow, currentRow ? currentRow.api_set_fields : null);
  const writtenNames = Object.keys(resolved.writable);
  const apiSetFields = mergeApiSetFields(currentRow ? currentRow.api_set_fields : null, writtenNames);
  return { writable: resolved.writable, writtenNames, apiSetFields };
}

async function createInquiryFromFactPayload(conn, orgId, session, channel, fields, summary) {
  const inquiryId = newId();
  const values = {
    first_name: fields.first_name || null,
    last_name: fields.last_name || null,
    email: fields.email || (channel === 'email' ? String(session.channel_user_id).toLowerCase() : null),
    phone: fields.phone || (channel === 'whatsapp' ? String(session.channel_user_id) : null),
    budget: fields.budget != null ? Number(fields.budget) : null,
    desired_start_date: fields.desired_start_date || null,
  };
  const written = INQUIRY_FACT_FIELDS.filter(field => values[field] !== null && values[field] !== undefined && values[field] !== '');
  await conn.execute(
    `INSERT INTO inquiry
       (id, org_id, inquiry_date, first_name, last_name, email, phone,
        notes, api_set_fields, source, status, desired_start_date, budget)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      inquiryId,
      orgId,
      values.first_name,
      values.last_name,
      values.email,
      values.phone,
      summary ? String(summary) : null,
      JSON.stringify(written),
      channel,
      values.desired_start_date,
      values.budget,
    ]
  );
  await conn.execute(
    `UPDATE chat_session
        SET inquiry_id = ?, lead_captured = 1
      WHERE id = ?`,
    [inquiryId, session.id]
  );
  return inquiryId;
}

async function applyFieldsAndSummaryToInquiry(conn, orgId, row, fields, summary) {
  const sets = [];
  const params = [];
  const { writable, writtenNames, apiSetFields } = buildFieldAssignments(fields, row);
  if (summary && !(row.notes && String(row.notes).trim())) {
    sets.push('notes = ?');
    params.push(String(summary));
  }
  sets.push('api_set_fields = ?');
  params.push(JSON.stringify(apiSetFields));
  for (const field of writtenNames) {
    sets.push(`${field} = ?`);
    params.push(field === 'budget' ? Number(writable[field]) : writable[field]);
  }
  sets.push('updated_at = NOW()');
  await conn.execute(`UPDATE inquiry SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [...params, row.id, orgId]);
  return writtenNames;
}

// POST /api/public/inquiry/from-chat
router.post('/inquiry/from-chat', async (req, res) => {
  const checked = validateInquiryFactRequest(req.body, { requireIsInquiry: true });
  if (!checked.ok) return fail(res, checked.error, 400);

  let conn;
  try {
    const orgId = req.apiKey.orgId;
    const b = req.body || {};
    const channel = String(b.channel);
    const channelUserId = String(b.channel_user_id);
    const idempotencyKey = String(b.idempotency_key);
    const hash = payloadHash(b);

    conn = await req.pool.getConnection();
    await conn.beginTransaction();

    const prior = await claimInquiryFactDelivery(conn, orgId, idempotencyKey, hash);
    if (prior) {
      await conn.commit();
      if (prior.payload_hash !== hash) return fail(res, 'idempotency_key_conflict', 409);
      return ok(res, inquiryFactResponse({
        inquiryId: prior.inquiry_id,
        created: false,
        applied: Number(prior.applied) === 1,
        reason: prior.reason || null,
      }));
    }

    await conn.execute(
      `INSERT INTO chat_session (id, channel, channel_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, NOW(), NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [newId(), channel, channelUserId]
    );
    const [[session]] = await conn.execute(
      `SELECT id, channel, channel_user_id, inquiry_id
         FROM chat_session
        WHERE channel = ? AND channel_user_id = ?
        LIMIT 1
        FOR UPDATE`,
      [channel, channelUserId]
    );
    if (b.conversation_id !== undefined) {
      await conn.execute(
        `UPDATE chat_session SET external_conversation_id = ? WHERE id = ?`,
        [b.conversation_id == null ? null : String(b.conversation_id), session.id]
      );
    }

    if (b.is_inquiry === false) {
      const outcome = inquiryFactResponse({ reason: 'not_inquiry' });
      await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
        inquiryId: null,
        applied: false,
        reason: 'not_inquiry',
      });
      await conn.commit();
      return ok(res, outcome);
    }

    let outcome;
    if (!session.inquiry_id) {
      const inquiryId = await createInquiryFromFactPayload(conn, orgId, session, channel, checked.fields, b.summary);
      outcome = inquiryFactResponse({ inquiryId, created: true, applied: true });
    } else {
      const gate = await loadLockedInquiryForFacts(conn, orgId, session.inquiry_id);
      if (!gate.reason) {
        await applyFieldsAndSummaryToInquiry(conn, orgId, gate.row, checked.fields, b.summary);
        outcome = inquiryFactResponse({ inquiryId: gate.row.id, created: false, applied: true });
      } else if (gate.reason === 'inquiry_closed' || gate.reason === 'inquiry_converted') {
        const inquiryId = await createInquiryFromFactPayload(conn, orgId, session, channel, checked.fields, b.summary);
        outcome = inquiryFactResponse({
          inquiryId,
          created: true,
          applied: true,
          supersededInquiryId: session.inquiry_id,
        });
      } else {
        outcome = inquiryFactResponse({
          inquiryId: session.inquiry_id,
          created: false,
          applied: false,
          reason: gate.reason,
        });
      }
    }

    await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
      inquiryId: outcome.inquiry_id,
      applied: outcome.applied,
      reason: outcome.reason,
    });
    await conn.commit();
    return ok(res, outcome);
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('Public inquiry from-chat error:', error);
    return fail(res, 'Failed to process inquiry facts');
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/public/inquiry/facts
router.post('/inquiry/facts', async (req, res) => {
  const checked = validateInquiryFactRequest(req.body);
  if (!checked.ok) return fail(res, checked.error, 400);

  let conn;
  try {
    const orgId = req.apiKey.orgId;
    const b = req.body || {};
    const channel = String(b.channel);
    const channelUserId = String(b.channel_user_id);
    const idempotencyKey = String(b.idempotency_key);
    const hash = payloadHash(b);

    conn = await req.pool.getConnection();
    await conn.beginTransaction();

    const prior = await claimInquiryFactDelivery(conn, orgId, idempotencyKey, hash);
    if (prior) {
      await conn.commit();
      if (prior.payload_hash !== hash) return fail(res, 'idempotency_key_conflict', 409);
      return ok(res, inquiryFactResponse({
        inquiryId: prior.inquiry_id,
        created: false,
        applied: Number(prior.applied) === 1,
        reason: prior.reason || null,
      }));
    }

    const [[session]] = await conn.execute(
      `SELECT id, channel, channel_user_id, inquiry_id
         FROM chat_session
        WHERE channel = ? AND channel_user_id = ?
        LIMIT 1
        FOR UPDATE`,
      [channel, channelUserId]
    );
    if (!session) {
      const outcome = inquiryFactResponse({ reason: 'no_session' });
      await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
        inquiryId: null,
        applied: false,
        reason: 'no_session',
      });
      await conn.commit();
      return ok(res, outcome);
    }

    if (b.conversation_id !== undefined) {
      await conn.execute(
        `UPDATE chat_session SET external_conversation_id = ? WHERE id = ?`,
        [b.conversation_id == null ? null : String(b.conversation_id), session.id]
      );
    }

    if (!session.inquiry_id) {
      const outcome = inquiryFactResponse({ reason: 'no_inquiry' });
      await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
        inquiryId: null,
        applied: false,
        reason: 'no_inquiry',
      });
      await conn.commit();
      return ok(res, outcome);
    }

    const gate = await loadLockedInquiryForFacts(conn, orgId, session.inquiry_id);
    if (gate.reason) {
      const outcome = inquiryFactResponse({
        inquiryId: session.inquiry_id,
        created: false,
        applied: false,
        reason: gate.reason,
      });
      await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
        inquiryId: session.inquiry_id,
        applied: false,
        reason: gate.reason,
      });
      await conn.commit();
      return ok(res, outcome);
    }

    const row = gate.row;
    const sets = [];
    const params = [];
    if (checked.facts.length) {
      const notes = appendFactsToNotes(row.notes, checked.facts, hkDate(b.occurred_at));
      if (notes.length > MAX_NOTES_CHARS) {
        const limitErr = new Error('notes_limit_reached');
        limitErr.publicStatus = 413;
        throw limitErr;
      }
      sets.push('notes = ?');
      params.push(notes);
    }

    const { writable, writtenNames, apiSetFields } = buildFieldAssignments(checked.fields, row);
    if (writtenNames.length) {
      sets.push('api_set_fields = ?');
      params.push(JSON.stringify(apiSetFields));
      for (const field of writtenNames) {
        sets.push(`${field} = ?`);
        params.push(field === 'budget' ? Number(writable[field]) : writable[field]);
      }
    }

    if (sets.length) {
      sets.push('updated_at = NOW()');
      await conn.execute(
        `UPDATE inquiry SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`,
        [...params, row.id, orgId]
      );
    }

    const outcome = inquiryFactResponse({ inquiryId: row.id, created: false, applied: true });
    await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
      inquiryId: row.id,
      applied: true,
      reason: null,
    });
    await conn.commit();
    return ok(res, outcome);
  } catch (error) {
    if (conn) await conn.rollback();
    if (error && error.publicStatus) return fail(res, error.message, error.publicStatus);
    console.error('Public inquiry facts error:', error);
    return fail(res, 'Failed to process inquiry facts');
  } finally {
    if (conn) conn.release();
  }
});

// ────────────────────────────────────────────────────────────────
// META / HEALTH
// ────────────────────────────────────────────────────────────────

// GET /api/public/health — confirms auth works, echoes caller's org + key name
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    org_id: String(req.apiKey.orgId),
    key_name: req.apiKey.name,
    timestamp: new Date().toISOString(),
  });
});

// ────────────────────────────────────────────────────────────────
// VIEWINGS — per-prospect booking link (TaneChat calls this)
// ────────────────────────────────────────────────────────────────

// POST /api/public/viewing-link
// The bot resolves the unit + extracts the prospect's preferred day, then calls
// this. We state-gate (unit must be open for viewings), mint a per-prospect,
// short-lived, prefilled link, and return it for the bot to send.
//
// Body: { unit_id, desired_date?: 'YYYY-MM-DD', prospect?: {name,phone,email} }
// → 200 { available:true, url, token, expires_at, prefill_date, unit:{...} }
// → 200 { available:false, reason:'not_marketing'|'unit_not_found' }
router.post('/viewing-link', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { unit_id, desired_date } = req.body || {};
    const prospect = (req.body && req.body.prospect) || {};
    if (!unit_id) return fail(res, 'unit_id is required', 400);

    // Resolve unit + property (org-scoped, active only).
    const [[unit]] = await req.pool.execute(
      `SELECT u.id, u.name AS unit_name, u.property_id, p.display_name AS property_name
         FROM unit u JOIN property p ON u.property_id = p.id
        WHERE u.id = ? AND p.org_id = ? AND u.active_status = 1 AND (u.deleted_at IS NULL)
        LIMIT 1`,
      [unit_id, orgId]
    );
    if (!unit) return ok(res, { available: false, reason: 'unit_not_found' });

    // State gate: open for viewings = the unit's current (departing) lease has
    // viewing_enabled=1 and hasn't ended. Closes automatically once re-leased.
    const [[lease]] = await req.pool.execute(
      `SELECT id, viewing_enabled FROM leasing
        WHERE unit_id = ? AND deleted_at IS NULL
          AND start_date <= CURDATE() AND (end_date >= CURDATE() OR end_date IS NULL)
        ORDER BY start_date DESC LIMIT 1`,
      [unit_id]
    );
    if (!lease || !Number(lease.viewing_enabled)) {
      return ok(res, { available: false, reason: 'not_marketing',
        message: 'This unit is not open for viewings right now.' });
    }

    // Assigned host: the unit's active staff-generated link's employee, if any.
    const [[link]] = await req.pool.execute(
      `SELECT employee_id FROM viewing_link
        WHERE unit_id = ? AND status = 1 AND employee_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [unit_id]
    );

    const prefillDate = (typeof desired_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(desired_date))
      ? desired_date : null;

    // Mint the per-prospect invite (7-day TTL) + register the token for org resolution.
    const invite = await mintInvite(req.pool, orgId, {
      unitId: unit_id,
      propertyId: unit.property_id,
      employeeId: link ? link.employee_id : null,
      leasingId: lease.id,
      prospect: { name: prospect.name, phone: prospect.phone, email: prospect.email },
      prefillDate,
      ttlDays: 7,
    });
    return ok(res, {
      available: true,
      url: invite.url,
      token: invite.token,
      prefill_date: prefillDate,
      expires_at: invite.expires_at,
      unit: { id: String(unit.id), name: unit.unit_name, property: unit.property_name },
    });
  } catch (err) {
    console.error('Public viewing-link error:', err);
    fail(res, 'Failed to create viewing link');
  }
});

// Resolve an active, marketed unit for the bot endpoints. Returns
// { unit, lease } or { reason } — caller decides the response shape.
async function resolveMarketedUnit(pool, orgId, unitId) {
  const [[unit]] = await pool.execute(
    `SELECT u.id, u.name AS unit_name, u.property_id, p.display_name AS property_name,
            p.street_address, p.city, p.state
       FROM unit u JOIN property p ON u.property_id = p.id
      WHERE u.id = ? AND p.org_id = ? AND u.active_status = 1 AND (u.deleted_at IS NULL)
      LIMIT 1`,
    [unitId, orgId]
  );
  if (!unit) return { reason: 'unit_not_found' };
  const [[lease]] = await pool.execute(
    `SELECT id, viewing_enabled FROM leasing
      WHERE unit_id = ? AND deleted_at IS NULL
        AND start_date <= CURDATE() AND (end_date >= CURDATE() OR end_date IS NULL)
      ORDER BY start_date DESC LIMIT 1`,
    [unitId]
  );
  // Occupied + opted in → marketable (the tenant will be asked).
  if (lease && Number(lease.viewing_enabled)) return { unit, lease };
  // Vacant (no current lease) → marketable IF staff have set up a host link for
  // it. No tenant to ask, so viewings are confirmed against the host directly.
  if (!lease) {
    const [[link]] = await pool.execute(
      `SELECT employee_id FROM viewing_link
        WHERE unit_id = ? AND status = 1 AND employee_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [unitId]
    );
    if (link && link.employee_id) return { unit, lease: null };
  }
  return { reason: 'not_marketing', unit };
}

function stripToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>(?=\S)/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// GET /api/public/viewing-prompt?unit_id=...
// Returns the rendered "please give us 2–3 times" prompt for the bot to send.
// The wording lives in the org's `Viewing-Prospect-Prompt` template (Settings →
// Email Templates), with a built-in fallback. State-gated.
// → 200 { available:true, prompt, unit:{...} } | { available:false, reason }
router.get('/viewing-prompt', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const unit_id = req.query.unit_id;
    if (!unit_id) return fail(res, 'unit_id is required', 400);

    const resolved = await resolveMarketedUnit(req.pool, orgId, unit_id);
    if (resolved.reason) {
      return ok(res, {
        available: false,
        reason: resolved.reason,
        message: resolved.reason === 'not_marketing'
          ? 'This unit is not open for viewings right now.' : 'Unit not found.',
      });
    }
    const { unit } = resolved;

    const vars = {
      '%Unit Name%': unit.unit_name || '',
      '%Property Name%': unit.property_name || '',
      '%Property Address%': [unit.street_address, unit.city, unit.state].filter(Boolean).join(', '),
    };
    let prompt =
      `Hi! We'd be glad to arrange a viewing of ${unit.unit_name} at ${unit.property_name}. ` +
      `Could you share 2–3 dates and times that suit you? Viewings run Monday–Saturday, 11am–7pm.`;
    try {
      const tpl = await loadTemplate(req.pool, orgId, 'Viewing-Prospect-Prompt');
      if (tpl && tpl.template_content) {
        prompt = stripToText(substituteVariables(tpl.template_content, vars));
      }
    } catch (e) {
      console.error('Public viewing-prompt template error:', e.message);
    }

    return ok(res, {
      available: true,
      prompt,
      unit: { id: String(unit.id), name: unit.unit_name, property: unit.property_name },
    });
  } catch (err) {
    console.error('Public viewing-prompt error:', err);
    fail(res, 'Failed to build viewing prompt');
  }
});

// POST /api/public/viewing-request
// TaneChat has parsed the prospect's reply into concrete times. We validate
// them against the viewing window, mint an invite PRE-FILLED with those times,
// and return a REVIEW link — the prospect opens it, double-checks the parsed
// times (fixing any mistake), and submits, which is what notifies the tenant.
//
// Body: { unit_id, prospect:{name,phone,email}, candidates:["YYYY-MM-DDTHH:mm", ...] }
// → 200 { available:true, review_url, token, expires_at, candidates, unit }
// → 200 { available:false, reason } | 400 { invalid: [...] }
router.post('/viewing-request', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { unit_id } = req.body || {};
    const prospect = (req.body && req.body.prospect) || {};
    const candidatesIn = (req.body && req.body.candidates) || [];
    if (!unit_id) return fail(res, 'unit_id is required', 400);
    if (!Array.isArray(candidatesIn) || candidatesIn.length === 0) {
      return fail(res, 'candidates must be a non-empty array of date-times', 400);
    }

    const resolved = await resolveMarketedUnit(req.pool, orgId, unit_id);
    if (resolved.reason) {
      return ok(res, {
        available: false,
        reason: resolved.reason,
        message: resolved.reason === 'not_marketing'
          ? 'This unit is not open for viewings right now.' : 'Unit not found.',
      });
    }
    const { unit, lease } = resolved;

    // Validate + normalise the parsed times against the viewing window.
    const seen = new Set();
    const times = [];
    const invalid = [];
    for (const c of candidatesIn) {
      const m = String(c).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
      if (!m) { invalid.push({ value: c, reason: 'unparseable' }); continue; }
      const norm = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
      if (seen.has(norm)) continue;
      const slotErr = validateBookingSlot(norm, 30);
      if (slotErr) { invalid.push({ value: c, reason: slotErr }); continue; }
      if (new Date(norm).getTime() < Date.now()) { invalid.push({ value: c, reason: 'in the past' }); continue; }
      seen.add(norm);
      times.push(norm);
    }
    if (times.length === 0) {
      return res.status(400).json({ code: 400, message: 'No valid times', invalid });
    }
    const candidates = times.sort().slice(0, 3);

    // Assigned host: the unit's active staff-generated link's employee, if any.
    const [[link]] = await req.pool.execute(
      `SELECT vl.employee_id, u.email AS employee_email FROM viewing_link vl
         LEFT JOIN user u ON u.id = vl.employee_id
        WHERE vl.unit_id = ? AND vl.status = 1 AND vl.employee_id IS NOT NULL
        ORDER BY vl.created_at DESC LIMIT 1`,
      [unit_id]
    );
    if (!link || !link.employee_id) {
      return ok(res, { available: false, reason: 'no_host',
        message: 'No host is assigned for this unit yet.' });
    }

    // Create the booking + candidates and prompt the tenant IMMEDIATELY (no wait
    // on the prospect). Drop any time the host is busy; fail only if none free.
    const booking = await createCandidateBooking(req.pool, orgId, {
      unitId: unit_id, propertyId: unit.property_id,
      unitName: unit.unit_name, propertyName: unit.property_name,
      propertyAddress: [unit.street_address, unit.city, unit.state].filter(Boolean).join(', '),
      employeeId: link.employee_id, employeeEmail: link.employee_email,
      prospect: { name: prospect.name, email: prospect.email, phone: prospect.phone },
      message: prospect.message || null,
      candidates, onClash: 'drop',
    });
    if (!booking.ok) {
      return ok(res, { available: false, reason: 'no_free_times',
        message: 'None of those times are available.', clashes: booking.clashes });
    }

    // Mint a review link (prefilled with the BOOKED times) and link it to the
    // booking, so the prospect can review/edit (editing re-asks the tenant).
    const bookedIso = booking.candidates.map(c => new Date(c.when).toISOString().slice(0, 19));
    const invite = await mintInvite(req.pool, orgId, {
      unitId: unit_id, propertyId: unit.property_id,
      employeeId: link.employee_id, leasingId: lease ? lease.id : null,
      prospect: { name: prospect.name, phone: prospect.phone, email: prospect.email },
      prefillDate: bookedIso[0].slice(0, 10), prefillTimes: bookedIso, ttlDays: 7,
    });
    await req.pool.execute('UPDATE viewing_invite SET booking_id = ? WHERE id = ?', [booking.bookingId, invite.id]);
    await req.pool.execute('UPDATE viewing_booking SET invite_id = ? WHERE id = ?', [invite.id, booking.bookingId]);

    // Ready-to-send text block of the BOOKED times (HK wall-clock).
    const summaryText = booking.candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n');

    return ok(res, {
      available: true,
      review_url: invite.url,
      token: invite.token,
      booking_id: booking.bookingId,
      has_tenant: booking.hasTenant,
      expires_at: invite.expires_at,
      candidates: booking.candidates.map(c => ({ label: c.label })),
      summary_text: summaryText,
      dropped: booking.dropped && booking.dropped.length ? booking.dropped : undefined,
      invalid: invalid.length ? invalid : undefined,
      unit: { id: String(unit.id), name: unit.unit_name, property: unit.property_name },
    });
  } catch (err) {
    console.error('Public viewing-request error:', err);
    fail(res, 'Failed to create viewing request');
  }
});

// ────────────────────────────────────────────────────────────────
// VIEWING RELAY SCHEDULER (conversational, Tenafy-owned state machine)
// TaneChat triggers `start` and forwards each PARSED reply; Tenafy owns state,
// calendar checks, templates and all outbound sending. See
// docs/superpowers/specs/2026-07-26-viewing-relay-scheduler-design.md
// ────────────────────────────────────────────────────────────────

function normPhoneDigits(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 8 ? d.slice(-8) : d; // compare on the local subscriber part
}

// POST /api/public/viewing-negotiation/start
// Body: { unit_id, prospect:{name,phone,email} }
// Staff pressed "Schedule Viewing". Creates the negotiation + first prospect prompt.
router.post('/viewing-negotiation/start', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { unit_id, unit_text } = req.body || {};
    const prospect = (req.body && req.body.prospect) || {};
    if (!unit_id && !unit_text) return fail(res, 'unit_id or unit_text is required', 400);
    if (!prospect.phone) return fail(res, 'prospect.phone is required', 400);

    // Text path: Tenafy resolves the unit from the raw phrase and reconfirms /
    // disambiguates in-relay before the day-ask (handles "mongkok 6a", "mk 6a", etc.).
    if (!unit_id && unit_text) {
      const out = await viewingNegotiation.startNegotiationFromText(req.pool, orgId, { unitText: unit_text, prospect });
      return ok(res, { available: true, ...out });
    }

    const resolved = await resolveMarketedUnit(req.pool, orgId, unit_id);
    if (resolved.reason) {
      return ok(res, { available: false, reason: resolved.reason,
        message: resolved.reason === 'not_marketing'
          ? 'This unit is not open for viewings right now.' : 'Unit not found.' });
    }
    // resolveMarketedUnit's lease only carries {id, viewing_enabled}; fetch tenant_id.
    let lease = null;
    if (resolved.lease) {
      const active = await findActiveLeaseForUnit(req.pool, unit_id);
      // id + dates come from the SAME active-lease row so the gate never evaluates
      // one lease's dates against another's id (both queries match the same current
      // lease, but keep them coupled defensively).
      lease = {
        id: active ? active.leasing_id : resolved.lease.id,
        tenant_id: active ? active.tenant_id : null,
        contract_type: active ? active.contract_type : null,
        end_date: active ? active.end_date : null,
      };
    }
    const out = await viewingNegotiation.startNegotiation(req.pool, orgId, {
      unit: resolved.unit, lease, prospect,
    });
    return ok(res, { available: true, ...out });
  } catch (err) {
    console.error('Public viewing-negotiation/start error:', err);
    fail(res, 'Failed to start viewing negotiation');
  }
});

// Shared handler for a parsed reply from either side.
async function handleNegotiationReply(req, res, party) {
  try {
    const orgId = req.apiKey.orgId;
    const negId = req.params.id;
    const intent = (req.body && req.body.intent) || {};
    const text = (req.body && req.body.text) || null;
    const messageId = (req.body && (req.body.message_id || req.body.messageId)) || null;
    const neg = await viewingNegotiation.loadNegotiation(req.pool, negId);
    if (!neg) return fail(res, 'Negotiation not found', 404);
    if (['CONFIRMED', 'CANCELLED', 'NEEDS_STAFF'].includes(neg.state)) {
      return ok(res, { closed: true, negotiation_id: negId, state: neg.state,
        message: 'This viewing request is no longer active — our team will follow up.' });
    }
    const out = await viewingNegotiation.handleReply(req.pool, orgId, neg, party, intent, text, messageId);
    return ok(res, {
      negotiation_id: negId,
      state: out.negotiation ? out.negotiation.state : null,
      awaiting: out.negotiation ? out.negotiation.awaiting : null,
      parties: out.parties,
      awaiting_phone: out.awaiting_phone,
      duplicate: out.duplicate || undefined,
      events: out.events,
    });
  } catch (err) {
    console.error(`Public viewing-negotiation ${party}-reply error:`, err);
    fail(res, 'Failed to process reply');
  }
}

// POST /api/public/viewing-negotiation/:id/prospect-reply  Body: { intent, text }
router.post('/viewing-negotiation/:id/prospect-reply', (req, res) => handleNegotiationReply(req, res, 'prospect'));
// POST /api/public/viewing-negotiation/:id/tenant-reply    Body: { intent, text }
router.post('/viewing-negotiation/:id/tenant-reply', (req, res) => handleNegotiationReply(req, res, 'tenant'));

// POST /api/public/viewing-negotiation/:id/draft-sent   Body: { event_id }
// MANUAL relay mode: Tenafy returns each composed outbound with status:'draft' in
// the reply/start response. TaneChat shows it as a pending reply in the thread and,
// on staff approval, SENDS it itself (it owns the WhatsApp — the message is a native
// TaneChat send in the thread). It then calls THIS to tell Tenafy the draft went out,
// so Tenafy records it as sent (Tenafy does NOT re-send). The draft/sent distinction
// is the event's `status` field — never a marker in the message body. Idempotent.
router.post('/viewing-negotiation/:id/draft-sent', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const negId = req.params.id;
    const eventId = (req.body && (req.body.event_id || req.body.eventId)) || null;
    if (!eventId) return fail(res, 'event_id is required', 400);
    // Confirm the outbound belongs to this negotiation AND this org (defense-in-depth
    // on top of the org-scoped pool).
    const [[ev]] = await req.pool.execute(
      `SELECT e.id FROM viewing_negotiation_event e
         JOIN viewing_negotiation n ON n.id = e.negotiation_id
        WHERE e.id = ? AND e.negotiation_id = ? AND e.direction = 'out' AND n.org_id = ? LIMIT 1`,
      [eventId, negId, orgId]
    );
    if (!ev) return fail(res, 'Draft not found', 404);
    const r = await viewingNegotiation.markDraftSent(req.pool, orgId, eventId);
    return ok(res, { recorded: true, negotiation_id: negId, event_id: String(eventId), already_sent: r.already_sent, status: r.status });
  } catch (err) {
    console.error('Public draft-sent error:', err);
    fail(res, 'Failed to record draft as sent');
  }
});

// GET /api/public/viewing-negotiation/active?phone=...
// Routing helper: given an inbound WhatsApp phone, find EVERY open negotiation it
// belongs to (as prospect and/or tenant), so TaneChat can tag the reply — and
// disambiguate when a number is in more than one active negotiation (multi-unit).
// → { active:bool, negotiations:[{ negotiation_id, party, state, awaiting }, ...] }
//   ordered newest-first, with the negotiation actually awaiting that party first.
router.get('/viewing-negotiation/active', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const target = normPhoneDigits(req.query.phone);
    if (!target) return ok(res, { active: false });
    const [rows] = await req.pool.execute(
      `SELECT n.id, n.state, n.awaiting, n.prospect_phone, t.phone AS tenant_phone
         FROM viewing_negotiation n
         LEFT JOIN tenant t ON t.id = n.tenant_id
        WHERE n.state NOT IN ('CONFIRMED','CANCELLED','NEEDS_STAFF')
        ORDER BY n.updated_at DESC LIMIT 200`,
      []
    );
    // Collect every negotiation this phone appears in (as prospect and/or tenant).
    // Rows are newest-first; prefer the one actually WAITING on that party so a
    // phone reused across negotiations (or that is both a tenant and a prospect)
    // routes to the negotiation expecting its reply.
    const matches = [];
    for (const r of rows) {
      if (normPhoneDigits(r.prospect_phone) === target) {
        matches.push({ negotiation_id: String(r.id), party: 'prospect', state: r.state, awaiting: r.awaiting });
      }
      if (r.tenant_phone && normPhoneDigits(r.tenant_phone) === target) {
        matches.push({ negotiation_id: String(r.id), party: 'tenant', state: r.state, awaiting: r.awaiting });
      }
    }
    if (!matches.length) return ok(res, { active: false, negotiations: [] });
    // Put the negotiation actually awaiting this party first (rows already newest-first).
    matches.sort((a, b) => (b.awaiting === b.party ? 1 : 0) - (a.awaiting === a.party ? 1 : 0));
    return ok(res, { active: true, negotiations: matches });
  } catch (err) {
    console.error('Public viewing-negotiation/active error:', err);
    fail(res, 'Failed to look up negotiation');
  }
});

// ────────────────────────────────────────────────────────────────
// CHATBOT — shared rulebook (public-tier only)
// ────────────────────────────────────────────────────────────────

// GET /api/public/chat/knowledge
// Returns the PUBLIC-visibility rulebook entries (chat_knowledge) so external
// channels (TaneChat / WhatsApp) can apply the same rules as the internal bot.
// Internal-only entries are NEVER returned here — the PII/permission boundary.
//
// Response: { rules:[{id,body,tags}], faqs:[{id,question,answer,tags}],
//             prompt_block, version, updated_at }
//   - prompt_block: a ready-to-append system-prompt fragment (TaneChat can splice
//     it straight into its prompt without re-rendering).
//   - version: cache key. Also sent as an ETag — pass it back in If-None-Match
//     and you'll get a 304 when nothing changed.
router.get('/chat/knowledge', async (req, res) => {
  try {
    let rows = [];
    try {
      const [r] = await req.pool.execute(
        `SELECT id, kind, title, body, tags, updated_at
         FROM chat_knowledge
         WHERE status = 1 AND visibility = 'public'
         ORDER BY sort_order ASC, created_at ASC`
      );
      rows = r;
    } catch (e) {
      // Table not present on a not-yet-migrated org DB — return an empty rulebook.
      if (e && e.code === 'ER_NO_SUCH_TABLE') rows = [];
      else throw e;
    }

    const parseTags = (t) => {
      if (t == null) return null;
      if (typeof t === 'string') { try { return JSON.parse(t); } catch { return null; } }
      return t;
    };

    const rules = rows.filter(r => r.kind !== 'faq').map(r => ({
      id: String(r.id), body: r.body, tags: parseTags(r.tags),
    }));
    const faqs = rows.filter(r => r.kind === 'faq').map(r => ({
      id: String(r.id), question: r.title || null, answer: r.body, tags: parseTags(r.tags),
    }));

    // Ready-to-append prompt fragment (mirrors the internal bot's renderer).
    let promptBlock = '';
    if (rules.length) {
      promptBlock += `Team rules (always follow these):\n` +
        rules.map(r => `- ${r.body}`).join('\n');
    }
    if (faqs.length) {
      if (promptBlock) promptBlock += '\n\n';
      promptBlock += `FAQ — use these answers when the question matches (do NOT invent beyond them):\n` +
        faqs.map(f => `- Q: ${f.question || '(question)'}\n  A: ${f.answer}`).join('\n');
    }

    // Version / ETag: row count + latest update time. Stable when nothing changes.
    let maxTs = 0;
    for (const r of rows) {
      const t = r.updated_at instanceof Date ? r.updated_at.getTime() : new Date(r.updated_at).getTime();
      if (Number.isFinite(t) && t > maxTs) maxTs = t;
    }
    const version = `${rows.length}-${maxTs}`;
    const updatedAt = maxTs ? new Date(maxTs).toISOString() : null;

    // Conditional GET: 304 when the caller already has this version.
    res.setHeader('ETag', `"${version}"`);
    const inm = req.headers['if-none-match'];
    if (inm && inm.replace(/"/g, '') === version) {
      return res.status(304).end();
    }

    ok(res, { rules, faqs, prompt_block: promptBlock, version, updated_at: updatedAt });
  } catch (error) {
    console.error('Public chat knowledge error:', error);
    fail(res, 'Failed to fetch chat knowledge');
  }
});

// POST /api/public/chat/log
// Write external-channel conversation turns into Tenafy's shared transcript store
// (chat_session + chat_message), so WhatsApp/TaneChat history lives alongside the
// internal bot's. This is the "shared diary" — call it AFTER you've replied to the
// user (fire-and-forget); it must never block a reply.
//
// Body: {
//   channel?: "whatsapp",                 // default "whatsapp"
//   channel_user_id: "85291234567",       // REQUIRED — stable id per WhatsApp user/thread
//   messages: [ { role, content, tokens_in?, tokens_out? }, ... ],  // REQUIRED, in order
//   viewer?: { name?, email?, phone?, language? }                   // optional enrichment
// }
// role ∈ {user, assistant, system, tool}. Send each turn ONCE (this appends).
const LOG_ROLES = ['user', 'assistant', 'system', 'tool'];
// Inbound prospect channels whose conversations should auto-create an inquiry.
const INQUIRY_CHANNELS = new Set(['whatsapp', 'email']);
router.post('/chat/log', async (req, res) => {
  try {
    const b = req.body || {};
    const channel = (b.channel && String(b.channel).trim()) || 'whatsapp';
    let channelUserId = b.channel_user_id != null ? String(b.channel_user_id).trim() : '';
    // Email is keyed by the address — normalise case so "A@x.com" and "a@x.com"
    // map to the same conversation/session.
    if (channel === 'email') channelUserId = channelUserId.toLowerCase();
    if (!channelUserId) return fail(res, 'channel_user_id is required', 400);
    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      return fail(res, 'messages must be a non-empty array', 400);
    }

    // Race-safe find-or-create against the unique (channel, channel_user_id)
    // key. Email connectors batch turns, so two requests can arrive at once —
    // INSERT … ON DUPLICATE KEY UPDATE avoids the SELECT-then-INSERT race that
    // would otherwise throw ER_DUP_ENTRY (500). Then read back the canonical id
    // (the existing row's, or the one we just inserted). No system-prompt seed —
    // the external bot owns its prompt.
    const newSessionId = newId();
    await req.pool.execute(
      `INSERT INTO chat_session (id, channel, channel_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, NOW(), NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [newSessionId, channel, channelUserId]
    );
    const [[sessRow]] = await req.pool.execute(
      'SELECT id FROM chat_session WHERE channel = ? AND channel_user_id = ? LIMIT 1',
      [channel, channelUserId]
    );
    const sessionId = String(sessRow.id);

    // Insert each message turn.
    let inserted = 0;
    for (const m of b.messages) {
      const role = LOG_ROLES.includes(m.role) ? m.role : null;
      if (!role) continue;
      const content = m.content != null ? String(m.content) : null;
      if (content == null && role !== 'tool') continue; // user/assistant/system need content
      await req.pool.execute(
        `INSERT INTO chat_message (id, session_id, role, content, tool_name, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(), sessionId, role, content,
          m.tool_name != null ? String(m.tool_name) : null,
          parseInt(m.tokens_in) || 0,
          parseInt(m.tokens_out) || 0,
        ]
      );
      inserted++;
    }

    // Bump counters + optionally enrich viewer details.
    await req.pool.execute(
      `UPDATE chat_session SET message_count = message_count + ?, last_message_at = NOW() WHERE id = ?`,
      [inserted, sessionId]
    );
    const v = b.viewer || {};
    if (v.name || v.email || v.phone || v.language) {
      await req.pool.execute(
        `UPDATE chat_session SET
           viewer_name  = COALESCE(?, viewer_name),
           viewer_email = COALESCE(?, viewer_email),
           viewer_phone = COALESCE(?, viewer_phone),
           language     = COALESCE(?, language)
         WHERE id = ?`,
        [v.name || null, v.email || null, v.phone || null, v.language || null, sessionId]
      );
    }

    // ── Auto-create inquiry on first qualifying turn ────────────────────
    // For inbound prospect channels (WhatsApp + email); only if the session has
    // no inquiry yet; only if the session is NOT already linked to a tenant;
    // only if there's at least one user message. The actual LLM call is
    // fire-and-forget so the log response isn't held up.
    if (INQUIRY_CHANNELS.has(channel) && inserted > 0) {
      setImmediate(() => {
        autoCreateInquiryForSession(req.pool, req.apiKey.orgId, sessionId)
          .catch(err => console.error('[chat/log] auto-extract failed:', err.message));
      });
    }

    ok(res, { session_id: sessionId, channel, inserted });
  } catch (error) {
    console.error('Public chat log error:', error);
    fail(res, 'Failed to log conversation');
  }
});

// Fire-and-forget inquiry creation for an inbound prospect session (WhatsApp or
// email). Idempotent — checks chat_session.inquiry_id and short-circuits if set.
async function autoCreateInquiryForSession(pool, orgId, sessionId) {
  // Re-fetch state inside the async call — by the time we run, the row may
  // have changed (e.g. a parallel turn already triggered creation).
  const [[session]] = await pool.execute(
    `SELECT id, channel, channel_user_id, inquiry_id, contact_id, viewer_phone, viewer_name, viewer_email
       FROM chat_session WHERE id = ? LIMIT 1`,
    [sessionId]
  );
  if (!session) return;
  if (session.inquiry_id) return;             // already extracted
  if (session.contact_id) return;             // linked tenant — not a prospect

  // Pull the conversation so far. Cap at the last 30 messages to bound
  // token cost; the very long chats are rare and the LLM still gets enough
  // to decide is_inquiry + extract the basics.
  const [messages] = await pool.execute(
    `SELECT role, content, created_at FROM chat_message
      WHERE session_id = ? ORDER BY created_at ASC LIMIT 30`,
    [sessionId]
  );
  if (!messages.length) return;
  const userMsgCount = messages.filter(m => m.role === 'user').length;
  if (userMsgCount < 1) return;

  const result = await inquiryExtractor.extractInitial(messages);
  if (!result.is_inquiry) {
    // Mark the attempt so we don't re-run on every subsequent turn for a
    // session the LLM already said isn't an inquiry. The daily re-extract
    // job ignores sessions without an inquiry_id anyway.
    await pool.execute(
      `UPDATE chat_session SET last_extracted_at = NOW(), extract_count = extract_count + 1 WHERE id = ?`,
      [sessionId]
    );
    return;
  }

  // Build the inquiry row, channel-aware:
  //  - source = the channel ('whatsapp' | 'email') so the inquiry is marked right.
  //  - email channel is keyed by the address, so use channel_user_id as the
  //    email fallback; phone only applies to phone-based channels (WhatsApp).
  const f = result.fields || {};
  const channel = session.channel || 'whatsapp';
  const isEmail = channel === 'email';
  const source = isEmail ? 'email' : (channel === 'whatsapp' ? 'whatsapp' : channel);
  const email = (f.email && String(f.email).trim().toLowerCase())
    || (session.viewer_email && String(session.viewer_email).trim().toLowerCase())
    || (isEmail && session.channel_user_id ? String(session.channel_user_id).trim().toLowerCase() : null);
  const phone = (f.phone && String(f.phone).trim()) || (isEmail ? null : session.viewer_phone) || null;
  const inquiryId = newId();

  await pool.execute(
    `INSERT INTO inquiry
       (id, org_id, inquiry_date, first_name, last_name, email, phone,
        notes, source, status, desired_start_date, budget)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      inquiryId, orgId,
      f.first_name || session.viewer_name || null,
      f.last_name || null,
      email,
      phone,
      f.notes || null,
      source,
      f.desired_start_date || null,
      f.budget != null && f.budget !== '' ? Number(f.budget) : null,
    ]
  );

  await pool.execute(
    `UPDATE chat_session
        SET inquiry_id = ?, last_extracted_at = NOW(), extract_count = extract_count + 1,
            lead_captured = 1
      WHERE id = ?`,
    [inquiryId, sessionId]
  );

  console.log(`[chat/log] auto-created inquiry ${inquiryId} for session ${sessionId} (org ${orgId})`);
}

// ────────────────────────────────────────────────────────────────
// PROPERTIES & UNITS
// ────────────────────────────────────────────────────────────────

// GET /api/public/units/available?date=YYYY-MM-DD&propertyId=123
// Units that are active AND have no lease covering the given date.
router.get('/units/available', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const propertyId = req.query.propertyId || null;

    let whereClause = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1';
    const params = [orgId];

    if (propertyId) {
      whereClause += ' AND p.id = ?';
      params.push(propertyId);
    }

    const [units] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.amenity_type,
              p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.state, p.district, p.country, p.zip_code, p.type AS property_type,
              last_lease.price AS last_lease_price, last_lease.end_date AS last_lease_end_date
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing active_lease
         ON active_lease.unit_id = u.id AND active_lease.deleted_at IS NULL
         AND active_lease.start_date <= ? AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)
       LEFT JOIN (
         SELECT l1.unit_id, l1.price, l1.end_date
         FROM leasing l1
         INNER JOIN (
           SELECT unit_id, MAX(start_date) AS max_start FROM leasing
           WHERE deleted_at IS NULL GROUP BY unit_id
         ) l2 ON l1.unit_id = l2.unit_id AND l1.start_date = l2.max_start
         WHERE l1.deleted_at IS NULL
       ) last_lease ON last_lease.unit_id = u.id
       WHERE ${whereClause} AND active_lease.id IS NULL
       ORDER BY p.display_name, u.name`,
      [date, date, ...params]
    );

    ok(res, units, { date });
  } catch (error) {
    console.error('Public available units error:', error);
    fail(res, 'Failed to fetch available units');
  }
});

// GET /api/public/units/search
// TaneChat-facing smart search. Filters + vacancy_gap sort.
// Query params:
//   move_in_date  (ISO date, default today)   — used for filtering + gap calc
//   move_out_date (ISO date, optional)        — excludes units booked in this range
//   bedrooms, bathrooms                       — exact match on unit.beds/baths
//   min_price, max_price                      — matched against last lease price OR rent_price_min/max
//   property_id                               — filter to property
//   city (csv)                                — region match, e.g. "Kowloon" or "Hong Kong Island" (case-insensitive)
//   district (csv)                            — neighbourhood match, e.g. "Causeway Bay,Wan Chai" (case-insensitive)
//   amenities (csv)                           — names like "parking,gym"; unit must have ALL
//   sort_by                                   — vacancy_gap (default), price_asc, price_desc
//   limit                                     — default 10, max 100
router.get('/units/search', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const moveIn = req.query.move_in_date || new Date().toISOString().split('T')[0];
    const moveOut = req.query.move_out_date || null;
    const bedrooms = req.query.bedrooms !== undefined ? Number(req.query.bedrooms) : null;
    const bathrooms = req.query.bathrooms !== undefined ? Number(req.query.bathrooms) : null;
    const minPrice = req.query.min_price !== undefined ? Number(req.query.min_price) : null;
    const maxPrice = req.query.max_price !== undefined ? Number(req.query.max_price) : null;
    // Prospect's stated budget. Purely enrichment — does NOT filter (use max_price
    // if you also want hard filtering). Drives over_budget_by / over_budget_pct
    // per unit so chatbot rules can make budget judgements without doing math.
    const budget = req.query.budget !== undefined ? Number(req.query.budget) : null;
    const propertyId = req.query.property_id || null;
    const cityNames = (req.query.city || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const districtNames = (req.query.district || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const amenityNames = (req.query.amenities || '').split(',').map(s => s.trim()).filter(Boolean);
    const sortBy = req.query.sort_by || 'vacancy_gap';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);

    // Delegate to the shared search engine (also used by the internal chatbot
    // tool, so both bots rank/filter identically). budgetMarginPct=0 keeps the
    // public API's strict max_price behavior unchanged.
    const { results, total } = await searchUnits(req.pool, {
      orgId,
      moveIn,
      moveOut,
      bedrooms: (bedrooms !== null && !Number.isNaN(bedrooms)) ? bedrooms : null,
      bathrooms: (bathrooms !== null && !Number.isNaN(bathrooms)) ? bathrooms : null,
      minPrice: (minPrice !== null && !Number.isNaN(minPrice)) ? minPrice : null,
      maxPrice: (maxPrice !== null && !Number.isNaN(maxPrice)) ? maxPrice : null,
      budgetMarginPct: 0,
      budget: (budget !== null && !Number.isNaN(budget)) ? budget : null,
      propertyId,
      cityNames,
      districtNames,
      amenityNames,
      sortBy,
      limit,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });

    ok(res, results, {
      total_matches: total,
      move_in_date: moveIn,
      move_out_date: moveOut,
      lease_duration_days: moveOut
        ? Math.max(0, Math.round((new Date(moveOut) - new Date(moveIn)) / 86400000))
        : null,
      budget: budget,
      sort_by: sortBy,
    });
  } catch (error) {
    console.error('Public units search error:', error);
    fail(res, 'Failed to search units');
  }
});

// GET /api/public/properties?date=YYYY-MM-DD&has_available_units=true
// All active properties with total/available unit counts + amenity names.
router.get('/properties', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const onlyAvailable = req.query.has_available_units === 'true' || req.query.has_available_units === '1';

    const [properties] = await req.pool.execute(
      `SELECT p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.state, p.district, p.country, p.zip_code, p.type AS property_type,
              p.currency, p.year_of_built, p.notes, p.payment_instructions, p.status,
              COUNT(u.id) AS total_units,
              SUM(CASE
                WHEN u.active_status = 1 AND NOT EXISTS (
                  SELECT 1 FROM leasing l
                  WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                    AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
                ) THEN 1 ELSE 0 END) AS available_units
       FROM property p
       LEFT JOIN unit u ON u.property_id = p.id AND u.active_status = 1
       WHERE p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.display_name`,
      [date, date, orgId]
    );

    // Attach amenity names per property
    let amenitiesByProp = new Map();
    if (properties.length > 0) {
      const propIds = properties.map(p => p.property_id);
      const ph = propIds.map(() => '?').join(',');
      const [amRows] = await req.pool.execute(
        `SELECT pa.property_id, a.display_name AS name FROM property_amenity pa
         JOIN amenity a ON pa.amenity_id = a.id
         WHERE pa.property_id IN (${ph})`,
        propIds
      );
      for (const r of amRows) {
        if (!amenitiesByProp.has(String(r.property_id))) amenitiesByProp.set(String(r.property_id), []);
        amenitiesByProp.get(String(r.property_id)).push(r.name);
      }
    }

    let result = properties.map(p => ({
      ...p,
      total_units: Number(p.total_units),
      available_units: Number(p.available_units),
      amenities: amenitiesByProp.get(String(p.property_id)) || [],
    }));

    if (onlyAvailable) result = result.filter(p => p.available_units > 0);

    ok(res, result, { date });
  } catch (error) {
    console.error('Public properties error:', error);
    fail(res, 'Failed to fetch properties');
  }
});

// GET /api/public/properties/:id — single property detail + amenities + gallery
router.get('/properties/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [properties] = await req.pool.execute(
      `SELECT p.*,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND EXISTS (
                SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                  AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
              )) as occupied_units
       FROM property p WHERE p.id = ? AND p.org_id = ? AND p.deleted_at IS NULL`,
      [id, orgId]
    );
    if (properties.length === 0) return fail(res, 'Property not found', 404);

    const [amenityRows] = await req.pool.execute(
      'SELECT amenity_id FROM property_amenity WHERE property_id = ?', [id]
    );
    const [galleryRows] = await req.pool.execute(
      'SELECT file_id, `order` FROM object_gallery WHERE object_id = ? ORDER BY `order`', [id]
    );

    res.json({
      code: 200,
      data: { ...properties[0], amenity_ids: amenityRows.map(r => r.amenity_id), gallery: galleryRows },
    });
  } catch (error) {
    console.error('Public property detail error:', error);
    fail(res, 'Failed to fetch property');
  }
});

// GET /api/public/units?property_id=&status=&active_status=
router.get('/units', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { property_id, status, active_status } = req.query;

    let whereClause = 'p.org_id = ? AND p.deleted_at IS NULL';
    const params = [orgId];
    if (property_id) { whereClause += ' AND u.property_id = ?'; params.push(property_id); }
    if (status !== undefined) { whereClause += ' AND u.status = ?'; params.push(status); }
    if (active_status !== undefined) { whereClause += ' AND u.active_status = ?'; params.push(active_status); }

    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name AS property_name, p.street_address, p.city, p.state, p.district, p.country
       FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE ${whereClause}
       ORDER BY p.display_name, u.name`,
      params
    );
    ok(res, units);
  } catch (error) {
    console.error('Public units list error:', error);
    fail(res, 'Failed to fetch units');
  }
});

// GET /api/public/units/:id — unit detail + current lease + tenant + amenities + gallery
router.get('/units/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name AS property_name, p.street_address, p.city, p.state,
              p.district, p.country, p.zip_code, p.currency, p.org_id
       FROM unit u JOIN property p ON u.property_id = p.id
       WHERE u.id = ? AND p.org_id = ?`,
      [id, orgId]
    );
    if (units.length === 0) return fail(res, 'Unit not found', 404);
    const unit = units[0];

    const [[currentLease]] = await req.pool.execute(
      `SELECT l.*, t.first_name, t.last_name, t.company_name, t.email, t.phone
       FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.unit_id = ? AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       ORDER BY l.start_date DESC LIMIT 1`,
      [id]
    );

    const [amenityRows] = await req.pool.execute(
      `SELECT ua.amenity_id, a.display_name AS name
       FROM unit_amenity ua LEFT JOIN amenity a ON ua.amenity_id = a.id
       WHERE ua.unit_id = ?`,
      [id]
    );
    const [galleryRows] = await req.pool.execute(
      'SELECT file_id, `order` FROM object_gallery WHERE object_id = ? ORDER BY `order`', [id]
    );

    // Active, assigned viewing link token (null if none exists or employee not yet assigned)
    const [[linkRow]] = await req.pool.execute(
      `SELECT token FROM viewing_link
       WHERE unit_id = ? AND status = 1 AND employee_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    // Compute current_move_out + available_from from the latest lease
    const [[latestLease]] = await req.pool.execute(
      `SELECT start_date, end_date, price FROM leasing
       WHERE unit_id = ? AND deleted_at IS NULL
       ORDER BY start_date DESC LIMIT 1`,
      [id]
    );
    let currentMoveOut = null;
    let availableFrom = new Date().toISOString().split('T')[0];
    if (latestLease && latestLease.end_date) {
      const endStr = latestLease.end_date instanceof Date
        ? latestLease.end_date.toISOString().split('T')[0]
        : String(latestLease.end_date).split('T')[0];
      currentMoveOut = endStr;
      const next = new Date(endStr);
      next.setDate(next.getDate() + 1);
      const nextStr = next.toISOString().split('T')[0];
      if (nextStr > availableFrom) availableFrom = nextStr;
    }

    const base = `${req.protocol}://${req.get('host')}`;

    res.json({
      code: 200,
      data: {
        ...unit,
        current_lease: currentLease || null,
        // Existing fields preserved for MCP/Telegram callers
        amenity_ids: amenityRows.map(r => r.amenity_id),
        gallery: galleryRows,
        booking_token: linkRow ? linkRow.token : null,
        // New fields for TaneChat-style consumers
        amenities: amenityRows.map(r => r.name).filter(Boolean),
        photos: galleryRows.map(r => `${base}/api/file/preview/${r.file_id}`),
        availability: {
          available_from: availableFrom,
          current_move_out: currentMoveOut,
          status: currentLease
            ? 'occupied_until_move_out'
            : currentMoveOut
              ? 'vacant'
              : 'never_leased',
        },
      },
    });
  } catch (error) {
    console.error('Public unit detail error:', error);
    fail(res, 'Failed to fetch unit');
  }
});

// GET /api/public/units/:id/availability?from_date=&to_date=
// Walks all non-deleted leases on the unit within [from_date, to_date]
// (defaults: today / +12 months) and returns the gaps between them as
// availability_windows. Also reports the lease covering today, if any.
router.get('/units/:id/availability', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = req.query.from_date || today;
    let toDate = req.query.to_date;
    if (!toDate) {
      const d = new Date(fromDate);
      d.setMonth(d.getMonth() + 12);
      toDate = d.toISOString().split('T')[0];
    }

    // Confirm unit exists in this org
    const [[unit]] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, p.display_name AS property_name
       FROM unit u JOIN property p ON u.property_id = p.id
       WHERE u.id = ? AND p.org_id = ?`,
      [id, orgId]
    );
    if (!unit) return fail(res, 'Unit not found', 404);

    // All leases overlapping [fromDate, toDate], ordered by start
    const [leases] = await req.pool.execute(
      `SELECT id, start_date, end_date, tenant_id
       FROM leasing
       WHERE unit_id = ? AND deleted_at IS NULL
         AND (end_date IS NULL OR end_date >= ?)
         AND start_date <= ?
       ORDER BY start_date ASC`,
      [id, fromDate, toDate]
    );

    const toStr = (d) => d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
    const addDays = (s, n) => {
      const d = new Date(s); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0];
    };

    // Find current lease (covers today)
    const currentLease = leases.find(l => {
      const s = toStr(l.start_date);
      const e = l.end_date ? toStr(l.end_date) : null;
      return s <= today && (!e || e >= today);
    });

    // Build availability windows = the gaps in [fromDate, toDate] not covered by any lease
    const windows = [];
    let cursor = fromDate;
    for (const l of leases) {
      const s = toStr(l.start_date);
      const e = l.end_date ? toStr(l.end_date) : null;
      if (s > cursor) {
        windows.push({
          available_from: cursor,
          available_until: addDays(s, -1),
          reason: 'Gap before next lease',
        });
      }
      if (!e) { cursor = null; break; } // open-ended lease — no more availability after this
      if (addDays(e, 1) > cursor) cursor = addDays(e, 1);
    }
    if (cursor && cursor <= toDate) {
      windows.push({
        available_from: cursor,
        available_until: toDate,
        reason: 'No lease scheduled',
      });
    }

    res.json({
      code: 200,
      data: {
        unit_id: String(unit.unit_id),
        unit_name: unit.unit_name,
        property_name: unit.property_name,
        from_date: fromDate,
        to_date: toDate,
        availability_windows: windows,
        current_lease: currentLease ? {
          tenant_move_out: currentLease.end_date ? toStr(currentLease.end_date) : null,
          status: currentLease.end_date ? 'notice_given' : 'active_open_ended',
        } : null,
      },
    });
  } catch (error) {
    console.error('Public unit availability error:', error);
    fail(res, 'Failed to fetch availability');
  }
});

// GET /api/public/amenities — all amenities available on this org
router.get('/amenities', async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      'SELECT id, name, type FROM amenity ORDER BY name'
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public amenities error:', error);
    fail(res, 'Failed to fetch amenities');
  }
});

// ────────────────────────────────────────────────────────────────
// TENANTS & CONTACTS
// ────────────────────────────────────────────────────────────────

// GET /api/public/tenants?status=&category=1|2
router.get('/tenants', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, category } = req.query;

    let whereClause = 'org_id = ?';
    const params = [orgId];
    if (status !== undefined) { whereClause += ' AND status = ?'; params.push(status); }
    if (category !== undefined) { whereClause += ' AND category = ?'; params.push(category); }
    else { whereClause += ' AND category = 1'; } // default to tenants, not payees

    const [tenants] = await req.pool.execute(
      `SELECT * FROM tenant WHERE ${whereClause}
       ORDER BY COALESCE(first_name, company_name, '') ASC, COALESCE(last_name, '') ASC`,
      params
    );
    ok(res, tenants);
  } catch (error) {
    console.error('Public tenants list error:', error);
    fail(res, 'Failed to fetch tenants');
  }
});

// GET /api/public/tenants/lookup?phone=<number>   OR   ?email=<address>
// Classify a contact: does the phone/email belong to an EXISTING tenant (current
// active lease), a FUTURE tenant (upcoming lease), a PAST tenant, or a prospect
// (tenant record but no lease) — or is it UNKNOWN (no match)?
//
// Pass EITHER `phone` or `email` (if both are given, `email` wins):
//   - phone: digit-only, last-8-suffix match, so "+852 9028 6718", "85290286718"
//     and "90286718" all match the same stored number (HK local length = 8).
//   - email: case-insensitive, trimmed, exact match against the tenant's primary
//     OR secondary email on file.
//
// Response data: {
//   matched, classification: existing|future|past|prospect|unknown, count,
//   tenants: [{ tenant_id, name, type, classification,
//               lease: { lease_no, status, unit, property, start_date, end_date } | null }]
// }
// NOTE: must be defined BEFORE '/tenants/:id' (static-before-dynamic).
router.get('/tenants/lookup', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const email = String(req.query.email || '').trim().toLowerCase();
    const digits = String(req.query.phone || '').replace(/\D/g, '');

    let tenants;
    if (email) {
      // Exact, case-insensitive match against primary OR secondary email.
      [tenants] = await req.pool.execute(
        `SELECT id, first_name, last_name, company_name, type
           FROM tenant
          WHERE org_id = ? AND category = 1
            AND ( LOWER(TRIM(email)) = ? OR LOWER(TRIM(secondary_email)) = ? )`,
        [orgId, email, email]
      );
    } else if (digits.length >= 7) {
      const lastN = Math.min(8, digits.length);
      const suffix = digits.slice(-lastN);
      [tenants] = await req.pool.execute(
        `SELECT id, first_name, last_name, company_name, type
           FROM tenant
          WHERE org_id = ? AND category = 1
            AND phone IS NOT NULL AND phone <> ''
            AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), ?) = ?`,
        [orgId, lastN, suffix]
      );
    } else {
      return fail(res, 'Provide a "phone" (>= 7 digits) or "email" query param.', 400);
    }

    if (tenants.length === 0) {
      return ok(res, { matched: false, classification: 'unknown', count: 0, tenants: [] });
    }

    const today = new Date().toISOString().slice(0, 10);
    const asDate = (d) => d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)) : null;
    const leaseStatus = (l) => {
      const s = asDate(l.start_date), e = asDate(l.end_date);
      if (s && s > today) return 'upcoming';
      if (e && e < today) return 'past';
      return 'active';
    };
    const rank = { active: 3, upcoming: 2, past: 1 };          // most-relevant lease
    const classOf = { active: 'existing', upcoming: 'future', past: 'past' };
    const topRank = { existing: 3, future: 2, past: 1, prospect: 0, unknown: -1 };

    const out = [];
    for (const t of tenants) {
      const [leases] = await req.pool.execute(
        `SELECT l.lease_no, l.start_date, l.end_date,
                u.name AS unit_name, p.display_name AS property_name
           FROM leasing l
           LEFT JOIN unit u ON l.unit_id = u.id
           LEFT JOIN property p ON u.property_id = p.id
          WHERE l.tenant_id = ? AND l.deleted_at IS NULL
          ORDER BY l.start_date DESC`,
        [t.id]
      );
      let best = null, bestStatus = null;
      for (const l of leases) {
        const st = leaseStatus(l);
        if (!best || rank[st] > rank[bestStatus]) { best = l; bestStatus = st; }
      }
      const classification = best ? classOf[bestStatus] : 'prospect';
      const name = Number(t.type) === 1
        ? (t.company_name || null)
        : ([t.first_name, t.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null);
      out.push({
        tenant_id: String(t.id),
        name,
        type: Number(t.type) === 1 ? 'company' : 'person',
        classification,
        lease: best ? {
          lease_no: best.lease_no || null,
          status: bestStatus,
          unit: best.unit_name || null,
          property: best.property_name || null,
          start_date: asDate(best.start_date),
          end_date: asDate(best.end_date),
        } : null,
      });
    }

    const classification = out.reduce(
      (acc, t) => (topRank[t.classification] > topRank[acc] ? t.classification : acc),
      'unknown'
    );
    ok(res, { matched: true, classification, count: out.length, tenants: out });
  } catch (error) {
    console.error('Public tenant lookup error:', error);
    fail(res, 'Failed to look up tenant');
  }
});

// GET /api/public/tenants/:id
router.get('/tenants/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [tenants] = await req.pool.execute(
      'SELECT * FROM tenant WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (tenants.length === 0) return fail(res, 'Tenant not found', 404);
    res.json({ code: 200, data: tenants[0] });
  } catch (error) {
    console.error('Public tenant detail error:', error);
    fail(res, 'Failed to fetch tenant');
  }
});

// GET /api/public/tenants/:id/leases
router.get('/tenants/:id/leases', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE l.tenant_id = ? AND p.org_id = ? AND l.deleted_at IS NULL
       ORDER BY l.start_date DESC`,
      [id, orgId]
    );
    ok(res, leases);
  } catch (error) {
    console.error('Public tenant leases error:', error);
    fail(res, 'Failed to fetch tenant leases');
  }
});

// GET /api/public/tenants/:id/invoices
router.get('/tenants/:id/invoices', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name AS category_name,
              u.name AS unit_name, p.display_name AS property_name
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       WHERE i.tenant_id = ? AND i.org_id = ? AND i.deleted_at IS NULL
       ORDER BY i.due_on DESC`,
      [id, orgId]
    );
    ok(res, invoices);
  } catch (error) {
    console.error('Public tenant invoices error:', error);
    fail(res, 'Failed to fetch tenant invoices');
  }
});

// GET /api/public/payees
router.get('/payees', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [payees] = await req.pool.execute(
      `SELECT * FROM tenant WHERE org_id = ? AND category = 2
       ORDER BY COALESCE(first_name, company_name, '') ASC, COALESCE(last_name, '') ASC`,
      [orgId]
    );
    ok(res, payees);
  } catch (error) {
    console.error('Public payees error:', error);
    fail(res, 'Failed to fetch payees');
  }
});

// GET /api/public/payees/:id
router.get('/payees/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [payees] = await req.pool.execute(
      'SELECT * FROM tenant WHERE id = ? AND org_id = ? AND category = 2',
      [id, orgId]
    );
    if (payees.length === 0) return fail(res, 'Payee not found', 404);
    res.json({ code: 200, data: payees[0] });
  } catch (error) {
    console.error('Public payee detail error:', error);
    fail(res, 'Failed to fetch payee');
  }
});

// GET /api/public/property-owners
router.get('/property-owners', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [owners] = await req.pool.execute(
      'SELECT * FROM property_owner WHERE org_id = ? AND deleted_at IS NULL ORDER BY first_name, last_name',
      [orgId]
    );
    ok(res, owners);
  } catch (error) {
    console.error('Public owners list error:', error);
    fail(res, 'Failed to fetch property owners');
  }
});

// GET /api/public/property-owners/:id
router.get('/property-owners/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [owners] = await req.pool.execute(
      'SELECT * FROM property_owner WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (owners.length === 0) return fail(res, 'Property owner not found', 404);
    res.json({ code: 200, data: owners[0] });
  } catch (error) {
    console.error('Public owner detail error:', error);
    fail(res, 'Failed to fetch property owner');
  }
});

// GET /api/public/service-vendors
router.get('/service-vendors', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [vendors] = await req.pool.execute(
      'SELECT * FROM service_vendor WHERE org_id = ? AND deleted_at IS NULL ORDER BY first_name, last_name',
      [orgId]
    );
    ok(res, vendors);
  } catch (error) {
    console.error('Public vendors list error:', error);
    fail(res, 'Failed to fetch service vendors');
  }
});

// GET /api/public/service-vendors/:id
router.get('/service-vendors/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [vendors] = await req.pool.execute(
      'SELECT * FROM service_vendor WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (vendors.length === 0) return fail(res, 'Service vendor not found', 404);
    res.json({ code: 200, data: vendors[0] });
  } catch (error) {
    console.error('Public vendor detail error:', error);
    fail(res, 'Failed to fetch service vendor');
  }
});

// ────────────────────────────────────────────────────────────────
// LEASES
// ────────────────────────────────────────────────────────────────

// GET /api/public/leases/expiring?days=30
// Static route — must be defined BEFORE /leases/:id
router.get('/leases/expiring', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const days = parseInt(req.query.days) || 30;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              DATEDIFF(l.end_date, NOW()) AS days_until_expiry
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL
         AND DATEDIFF(l.end_date, NOW()) BETWEEN 0 AND ?
       ORDER BY l.end_date ASC`,
      [orgId, days]
    );
    ok(res, leases, { days });
  } catch (error) {
    console.error('Public expiring leases error:', error);
    fail(res, 'Failed to fetch expiring leases');
  }
});

// GET /api/public/leases?status=active|upcoming|inactive|terminated&unit_id=&tenant_id=
router.get('/leases', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, unit_id, tenant_id } = req.query;

    let whereClause = 'p.org_id = ? AND l.deleted_at IS NULL';
    const params = [orgId];
    if (unit_id) { whereClause += ' AND l.unit_id = ?'; params.push(unit_id); }
    if (tenant_id) { whereClause += ' AND l.tenant_id = ?'; params.push(tenant_id); }

    if (status === 'active') {
      whereClause += ' AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)';
    } else if (status === 'upcoming') {
      whereClause += ' AND l.start_date > CURDATE()';
    } else if (status === 'inactive') {
      whereClause += ' AND l.end_date < CURDATE()';
    }
    // 'terminated' is handled by deleted_at, which is always excluded above

    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email, t.phone AS tenant_phone,
              CASE
                WHEN l.start_date > CURDATE() THEN 'upcoming'
                WHEN l.end_date < CURDATE() THEN 'inactive'
                ELSE 'active'
              END AS lease_status
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY l.start_date DESC`,
      params
    );
    ok(res, leases);
  } catch (error) {
    console.error('Public leases list error:', error);
    fail(res, 'Failed to fetch leases');
  }
});

// GET /api/public/leases/:id — lease detail + additional tenants
router.get('/leases/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email, t.phone AS tenant_phone,
              CASE
                WHEN l.start_date > CURDATE() THEN 'upcoming'
                WHEN l.end_date < CURDATE() THEN 'inactive'
                ELSE 'active'
              END AS lease_status
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL`,
      [id, orgId]
    );
    if (leases.length === 0) return fail(res, 'Lease not found', 404);
    const lease = leases[0];

    const [additional] = await req.pool.execute(
      `SELECT t.id, t.first_name, t.last_name, t.company_name, t.type, t.email, t.phone
       FROM leasing_additional_tenant lat
       LEFT JOIN tenant t ON t.id = lat.tenant_id
       WHERE lat.leasing_id = ?`,
      [id]
    );

    res.json({ code: 200, data: { ...lease, additional_tenants: additional } });
  } catch (error) {
    console.error('Public lease detail error:', error);
    fail(res, 'Failed to fetch lease');
  }
});

// ────────────────────────────────────────────────────────────────
// INVOICES & PAYMENTS
// ────────────────────────────────────────────────────────────────

// GET /api/public/invoices?status=&tenant_id=&from=&to=
router.get('/invoices', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, tenant_id, from, to, property_id, unit_id } = req.query;

    let whereClause = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];
    if (status !== undefined) { whereClause += ' AND i.status = ?'; params.push(status); }
    if (tenant_id) { whereClause += ' AND i.tenant_id = ?'; params.push(tenant_id); }
    if (property_id) { whereClause += ' AND i.property_id = ?'; params.push(property_id); }
    if (unit_id) { whereClause += ' AND i.unit_id = ?'; params.push(unit_id); }
    if (from) { whereClause += ' AND i.due_on >= ?'; params.push(from); }
    if (to) { whereClause += ' AND i.due_on <= ?'; params.push(to); }

    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name AS category_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name,
              u.name AS unit_name, p.display_name AS property_name,
              bp.name AS booking_platform_name,
              sa.name AS sales_agent_name,
              lbp.name AS lease_booking_platform_name,
              lsa.name AS lease_sales_agent_name
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN booking_platform bp ON i.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON i.sales_agent_id = sa.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       LEFT JOIN booking_platform lbp ON l.booking_platform_id = lbp.id
       LEFT JOIN sales_agent lsa ON l.sales_agent_id = lsa.id
       WHERE ${whereClause}
       ORDER BY i.due_on DESC`,
      params
    );
    ok(res, invoices);
  } catch (error) {
    console.error('Public invoices list error:', error);
    fail(res, 'Failed to fetch invoices');
  }
});

// GET /api/public/invoices/:id — invoice detail + payment history
router.get('/invoices/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name AS category_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email,
              p.display_name AS property_name, u.name AS unit_name,
              l.lease_no,
              bp.name AS booking_platform_name,
              sa.name AS sales_agent_name,
              lbp.name AS lease_booking_platform_name,
              lsa.name AS lease_sales_agent_name
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       LEFT JOIN booking_platform bp ON i.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON i.sales_agent_id = sa.id
       LEFT JOIN booking_platform lbp ON l.booking_platform_id = lbp.id
       LEFT JOIN sales_agent lsa ON l.sales_agent_id = lsa.id
       WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL`,
      [id, orgId]
    );
    if (invoices.length === 0) return fail(res, 'Invoice not found', 404);
    const inv = invoices[0];

    const [payments] = await req.pool.execute(
      `SELECT DISTINCT a.id, a.transaction_code, a.payment_date, a.amount AS header_amount, a.type, a.note,
              al.amount, pms.payment_method AS payment_method_name
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL
       ORDER BY a.payment_date DESC`,
      [inv.invoice_code, orgId]
    );

    const amountPaid = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const outstanding = Number(inv.status) === 1 ? 0 : Math.max(0, (parseFloat(inv.amount) || 0) - amountPaid);

    res.json({ code: 200, data: { ...inv, payments, amount_paid: amountPaid, outstanding } });
  } catch (error) {
    console.error('Public invoice detail error:', error);
    fail(res, 'Failed to fetch invoice');
  }
});

// GET /api/public/payments?tenant_id=&from=&to=
router.get('/payments', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { tenant_id, from, to } = req.query;

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];
    if (tenant_id) { whereClause += ' AND a.tenant_id = ?'; params.push(tenant_id); }
    if (from) { whereClause += ' AND a.payment_date >= ?'; params.push(from); }
    if (to) { whereClause += ' AND a.payment_date <= ?'; params.push(to); }

    const [payments] = await req.pool.execute(
      `SELECT a.id, a.transaction_code, a.invoice_code, a.payment_date, a.amount, a.type, a.note,
              a.tenant_id, a.property_id, a.unit_id, a.lease_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              pms.payment_method AS payment_method_name,
              cs.name AS category_name,
              p.display_name AS property_name, u.name AS unit_name
       FROM accounting a
       LEFT JOIN tenant t ON a.tenant_id = t.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN unit u ON a.unit_id = u.id
       WHERE ${whereClause}
       ORDER BY a.payment_date DESC`,
      params
    );
    ok(res, payments);
  } catch (error) {
    console.error('Public payments list error:', error);
    fail(res, 'Failed to fetch payments');
  }
});

// ────────────────────────────────────────────────────────────────
// ACCOUNTING
// ────────────────────────────────────────────────────────────────

// GET /api/public/accounting?type=0|1&category=&from=&to=
router.get('/accounting', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { type, category, from, to, tenant_id, property_id } = req.query;

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];
    if (type !== undefined) { whereClause += ' AND a.type = ?'; params.push(type); }
    if (category) { whereClause += ' AND a.category = ?'; params.push(category); }
    if (tenant_id) { whereClause += ' AND a.tenant_id = ?'; params.push(tenant_id); }
    if (property_id) { whereClause += ' AND a.property_id = ?'; params.push(property_id); }
    if (from) { whereClause += ' AND a.payment_date >= ?'; params.push(from); }
    if (to) { whereClause += ' AND a.payment_date <= ?'; params.push(to); }

    const [entries] = await req.pool.execute(
      `SELECT a.*, cs.name AS category_name,
              ast.name AS account_name,
              pms.payment_method AS payment_method_name,
              p.display_name AS property_name, u.name AS unit_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM accounting a
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN unit u ON a.unit_id = u.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY a.payment_date DESC`,
      params
    );
    ok(res, entries);
  } catch (error) {
    console.error('Public accounting list error:', error);
    fail(res, 'Failed to fetch accounting entries');
  }
});

// GET /api/public/accounting/:id — entry detail + lines
router.get('/accounting/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [rows] = await req.pool.execute(
      `SELECT a.*, cs.name AS category_name, ast.name AS account_name,
              pms.payment_method AS payment_method_name,
              p.display_name AS property_name, u.name AS unit_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM accounting a
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN unit u ON a.unit_id = u.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE a.id = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
      [id, orgId]
    );
    if (rows.length === 0) return fail(res, 'Entry not found', 404);

    const [lines] = await req.pool.execute(
      `SELECT al.*, cs.name AS category_name,
              p.display_name AS property_name, u.name AS unit_name
       FROM accounting_line al
       LEFT JOIN category_setting cs ON al.category = cs.id
       LEFT JOIN property p ON al.property_id = p.id
       LEFT JOIN unit u ON al.unit_id = u.id
       WHERE al.accounting_id = ? AND al.deleted_at IS NULL`,
      [id]
    );

    res.json({ code: 200, data: { ...rows[0], lines } });
  } catch (error) {
    console.error('Public accounting detail error:', error);
    fail(res, 'Failed to fetch accounting entry');
  }
});

// ────────────────────────────────────────────────────────────────
// SERVICES
// ────────────────────────────────────────────────────────────────

// GET /api/public/services?status=
router.get('/services', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, unit_id, property_id } = req.query;

    let whereClause = 's.org_id = ? AND s.deleted_at IS NULL';
    const params = [orgId];
    if (status !== undefined) { whereClause += ' AND s.status = ?'; params.push(status); }
    if (unit_id) { whereClause += ' AND s.unit_id = ?'; params.push(unit_id); }
    if (property_id) { whereClause += ' AND p.id = ?'; params.push(property_id); }

    const [services] = await req.pool.execute(
      `SELECT s.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              sv.first_name AS assignee_first_name, sv.last_name AS assignee_last_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name, t.phone AS tenant_phone
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN service_vendor sv ON s.assignee = sv.id
       LEFT JOIN tenant t ON s.created_by = t.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC`,
      params
    );
    ok(res, services);
  } catch (error) {
    console.error('Public services list error:', error);
    fail(res, 'Failed to fetch services');
  }
});

// GET /api/public/services/:id — detail + activity timeline
router.get('/services/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [services] = await req.pool.execute(
      `SELECT s.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              sv.first_name AS assignee_first_name, sv.last_name AS assignee_last_name,
              sv2.first_name AS assignee_2_first_name, sv2.last_name AS assignee_2_last_name,
              CASE WHEN rb.type = 1 THEN rb.company_name
                   ELSE CONCAT(COALESCE(rb.first_name,''), ' ', COALESCE(rb.last_name,''))
              END AS reported_by_name, rb.phone AS reported_by_phone,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name, t.phone AS tenant_phone
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN service_vendor sv ON s.assignee = sv.id
       LEFT JOIN service_vendor sv2 ON s.assignee_2 = sv2.id
       LEFT JOIN tenant rb ON s.reported_by = rb.id
       LEFT JOIN tenant t ON s.created_by = t.id
       WHERE s.id = ? AND s.org_id = ? AND s.deleted_at IS NULL`,
      [id, orgId]
    );
    if (services.length === 0) return fail(res, 'Service not found', 404);

    const [activities] = await req.pool.execute(
      `SELECT sa.*, u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM service_activity sa
       LEFT JOIN user u ON sa.created_by = u.id
       WHERE sa.service_id = ? AND sa.org_id = ?
       ORDER BY sa.created_at ASC`,
      [id, orgId]
    );

    res.json({ code: 200, data: { ...services[0], activities } });
  } catch (error) {
    console.error('Public service detail error:', error);
    fail(res, 'Failed to fetch service');
  }
});

// ────────────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────────────

// GET /api/public/utility/groups
router.get('/utility/groups', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [rows] = await req.pool.execute(
      `SELECT g.id, g.name, g.property_id, g.status, p.display_name AS property_name
       FROM utility_group g
       LEFT JOIN property p ON g.property_id = p.id
       WHERE g.org_id = ? AND g.status = 1
       ORDER BY g.name`,
      [orgId]
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public utility groups error:', error);
    fail(res, 'Failed to fetch utility groups');
  }
});

// GET /api/public/utility/bills?group_id=
router.get('/utility/bills', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { group_id } = req.query;

    let sql = `SELECT b.id, b.group_id, b.period_start, b.period_end,
                      b.total_amount, b.total_kw, b.rate_per_kw, b.status,
                      g.name AS group_name
               FROM utility_bill b
               LEFT JOIN utility_group g ON b.group_id = g.id
               WHERE b.org_id = ?`;
    const params = [orgId];
    if (group_id) { sql += ' AND b.group_id = ?'; params.push(group_id); }
    sql += ' ORDER BY b.period_start DESC';

    const [rows] = await req.pool.execute(sql, params);
    ok(res, rows);
  } catch (error) {
    console.error('Public utility bills error:', error);
    fail(res, 'Failed to fetch utility bills');
  }
});

// GET /api/public/utility/bills/:id — bill + all lines
router.get('/utility/bills/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [[bill]] = await req.pool.execute(
      `SELECT b.*, g.name AS group_name
       FROM utility_bill b
       LEFT JOIN utility_group g ON b.group_id = g.id
       WHERE b.id = ? AND b.org_id = ?`,
      [id, orgId]
    );
    if (!bill) return fail(res, 'Bill not found', 404);

    const [lines] = await req.pool.execute(
      `SELECT bl.*, m.meter_number, m.meter_type, m.meter_category,
              u.name AS unit_name, p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              i.invoice_code, i.status AS invoice_status
       FROM utility_bill_line bl
       LEFT JOIN utility_meter m ON bl.meter_id = m.id
       LEFT JOIN unit u ON bl.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON bl.tenant_id = t.id
       LEFT JOIN invoice i ON bl.invoice_id = i.id
       WHERE bl.bill_id = ?
       ORDER BY bl.is_common_area, u.name, m.meter_number`,
      [id]
    );

    res.json({ code: 200, data: { ...bill, lines } });
  } catch (error) {
    console.error('Public utility bill detail error:', error);
    fail(res, 'Failed to fetch utility bill');
  }
});

// GET /api/public/utility/meters?group_id=&unit_id=
router.get('/utility/meters', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { group_id, unit_id } = req.query;

    let sql = `SELECT m.id, m.group_id, m.unit_id, m.meter_number, m.meter_type,
                      m.meter_category, m.current_reading, m.status,
                      g.name AS group_name, u.name AS unit_name, p.display_name AS property_name
               FROM utility_meter m
               LEFT JOIN utility_group g ON m.group_id = g.id
               LEFT JOIN unit u ON m.unit_id = u.id
               LEFT JOIN property p ON u.property_id = p.id
               WHERE m.org_id = ? AND m.status = 1`;
    const params = [orgId];
    if (group_id) { sql += ' AND m.group_id = ?'; params.push(group_id); }
    if (unit_id) { sql += ' AND m.unit_id = ?'; params.push(unit_id); }
    sql += ' ORDER BY g.name, m.meter_category, u.name, m.meter_number';

    const [rows] = await req.pool.execute(sql, params);
    ok(res, rows);
  } catch (error) {
    console.error('Public utility meters error:', error);
    fail(res, 'Failed to fetch utility meters');
  }
});

// GET /api/public/utility/meters/:id/readings
router.get('/utility/meters/:id/readings', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    // Confirm meter belongs to org
    const [[meter]] = await req.pool.execute(
      'SELECT id FROM utility_meter WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!meter) return fail(res, 'Meter not found', 404);

    const [rows] = await req.pool.execute(
      `SELECT mr.*, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM utility_meter_reading mr
       LEFT JOIN tenant t ON mr.tenant_id = t.id
       WHERE mr.meter_id = ? AND mr.org_id = ?
       ORDER BY mr.reading_date DESC, mr.created_at DESC`,
      [id, orgId]
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public utility readings error:', error);
    fail(res, 'Failed to fetch meter readings');
  }
});

// GET /api/public/utility/settlements — all checkout settlements
router.get('/utility/settlements', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { tenant_id } = req.query;

    let sql = `SELECT cs.*, m.meter_number, u.name AS unit_name, p.display_name AS property_name,
                      t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                      i.invoice_code, i.status AS invoice_status
               FROM utility_checkout_settlement cs
               LEFT JOIN utility_meter m ON cs.meter_id = m.id
               LEFT JOIN unit u ON m.unit_id = u.id
               LEFT JOIN property p ON u.property_id = p.id
               LEFT JOIN tenant t ON cs.tenant_id = t.id
               LEFT JOIN invoice i ON cs.invoice_id = i.id
               WHERE cs.org_id = ?`;
    const params = [orgId];
    if (tenant_id) { sql += ' AND cs.tenant_id = ?'; params.push(tenant_id); }
    sql += ' ORDER BY cs.created_at DESC';

    const [rows] = await req.pool.execute(sql, params);
    ok(res, rows);
  } catch (error) {
    console.error('Public utility settlements error:', error);
    fail(res, 'Failed to fetch settlements');
  }
});

// ────────────────────────────────────────────────────────────────
// CLEANING
// ────────────────────────────────────────────────────────────────

// GET /api/public/cleaning/cleaners
router.get('/cleaning/cleaners', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [rows] = await req.pool.execute(
      'SELECT id, name, status, created_at FROM cleaner WHERE org_id = ? ORDER BY name',
      [orgId]
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public cleaners error:', error);
    fail(res, 'Failed to fetch cleaners');
  }
});

// GET /api/public/cleaning/schedule?week_of=YYYY-MM-DD
router.get('/cleaning/schedule', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { week_of } = req.query;
    if (!week_of) return fail(res, 'week_of required', 400);

    const [rows] = await req.pool.execute(
      `SELECT cs.id, cs.property_id, cs.unit_id, cs.cleaner_id, cs.scheduled_date,
              cs.type, cs.lease_id, cs.tenant_id, cs.status, cs.notes, cs.cleaning_notes,
              p.display_name AS property_name, u.name AS unit_name,
              cl.name AS cleaner_name,
              t.first_name, t.last_name
       FROM cleaning_schedule cs
       JOIN unit u ON cs.unit_id = u.id
       JOIN property p ON cs.property_id = p.id
       LEFT JOIN cleaner cl ON cs.cleaner_id = cl.id
       LEFT JOIN tenant t ON cs.tenant_id = t.id
       WHERE cs.org_id = ? AND cs.week_of = ?
       ORDER BY cs.scheduled_date, p.display_name, u.name`,
      [orgId, week_of]
    );
    ok(res, rows, { week_of });
  } catch (error) {
    console.error('Public cleaning schedule error:', error);
    fail(res, 'Failed to fetch cleaning schedule');
  }
});

module.exports = router;

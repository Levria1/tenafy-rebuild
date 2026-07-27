/**
 * Viewing Relay Scheduler — the negotiation state machine.
 *
 * Staff press "Schedule Viewing" in TaneChat; Tenafy then relays a viewing
 * negotiation between the prospect and the current tenant over WhatsApp:
 *   ASK_PROSPECT_DAY → CHECK_STAFF → AWAIT_TENANT ⇄ ASK_TENANT_ALT ⇄
 *   RELAY_TO_PROSPECT → CONFIRMED | NEEDS_STAFF | CANCELLED
 *
 * Tenafy owns ALL outbound sending (via the sendWhatsApp gateway, to either the
 * prospect's or the tenant's phone). TaneChat is a thin relay: it triggers
 * `startNegotiation` and forwards each parsed inbound reply (a structured
 * `intent`) to `handleReply`. Every outbound message is a template with a
 * built-in fallback; in relay_mode='manual' it is queued as a `draft` for staff
 * to approve on the dashboard, in 'auto' it is sent immediately.
 *
 * Self-contained on purpose (like viewingBooking.js): it does not reuse the
 * link-flow helpers, so the older /link and /invite routes stay untouched. The
 * final CONFIRMED appointment IS funnelled through the shared confirmation path
 * (viewingNotify.sendViewingConfirmation) so Google Calendar + .ics + emails are
 * identical to every other viewing.
 */

const crypto = require('crypto');
const { getMasterPool } = require('../config/poolRegistry');
const { getFreeBusy } = require('./googleCalendar');
const { sendWhatsApp } = require('./whatsappService');
const { sendViewingConfirmation } = require('./viewingNotify');
const { loadTemplate, substituteVariables } = require('./emailService');
const { KIND_ACTION, KIND_MANAGE } = require('../middleware/viewingTokenAuth');
const {
  DEFAULT_SETTING, combineDateTime, minutesOf, withinWindow, nextStep, buildRouting,
} = require('./viewingNegotiationLogic');

// ── small helpers ──────────────────────────────────────────────────────────
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function newActionToken() {
  return crypto.randomBytes(24).toString('hex');
}
function formatWhen(dt) {
  if (!dt) return '';
  try {
    return new Date(dt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return String(dt); }
}
// Format a DATETIME (mysql2 returns a Date in the connection's local TZ) back to
// its wall-clock 'YYYY-MM-DDTHH:mm:ss' — NEVER via toISOString(), which shifts to
// UTC and corrupts the time on a non-UTC server.
function dateToWallClock(d) {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
function stripToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// buildRouting is imported from ./viewingNegotiationLogic (pure).

// ── settings ────────────────────────────────────────────────────────────────
async function getSetting(pool, orgId) {
  try {
    const [[row]] = await pool.execute('SELECT * FROM viewing_setting WHERE org_id = ? LIMIT 1', [orgId]);
    if (!row) return { ...DEFAULT_SETTING };
    return {
      relay_mode: row.relay_mode || 'manual',
      max_rounds: Number(row.max_rounds) || 3,
      viewing_days: row.viewing_days || DEFAULT_SETTING.viewing_days,
      viewing_start: row.viewing_start || DEFAULT_SETTING.viewing_start,
      viewing_end: row.viewing_end || DEFAULT_SETTING.viewing_end,
    };
  } catch {
    return { ...DEFAULT_SETTING }; // table not migrated yet
  }
}

// Pure logic (combineDateTime / minutesOf / withinWindow / nextStep / DEFAULT_SETTING)
// lives in ./viewingNegotiationLogic and is imported at the top of this file.

// ── roster + calendar ────────────────────────────────────────────────────────
async function resolveStaffOfDay(pool, propertyId, whenIso) {
  const m = String(whenIso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const weekday = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  try {
    const [[row]] = await pool.execute(
      `SELECT r.employee_id, u.email, u.google_calendar_id, u.first_name, u.last_name,
              u.viewing_buffer_minutes AS buffer
         FROM viewing_staff_roster r JOIN user u ON u.id = r.employee_id
        WHERE r.property_id = ? AND r.weekday = ? AND r.active = 1 LIMIT 1`,
      [propertyId, weekday]
    );
    return row || null;
  } catch {
    return null; // table not migrated
  }
}

// Load a specific staffer (the one LOCKED onto the negotiation) by id — used at
// confirm time so a roster edit between proposal and acceptance can't reassign
// the booking to a different person.
async function loadStaffById(pool, employeeId) {
  if (!employeeId) return null;
  const [[row]] = await pool.execute(
    `SELECT id AS employee_id, email, google_calendar_id, first_name, last_name,
            viewing_buffer_minutes AS buffer
       FROM user WHERE id = ? LIMIT 1`,
    [employeeId]
  );
  return row || null;
}

// Is `whenIso` free for this staffer (their bookings + Google busy + buffer)?
async function checkStaffFree(pool, { employeeId, unitId, whenIso, buffer, calendarId }) {
  const bufferMin = (buffer == null || isNaN(Number(buffer))) ? 30 : Number(buffer);
  const start = new Date(whenIso);
  const end = new Date(start.getTime() + 30 * 60000);
  const padStart = new Date(start.getTime() - bufferMin * 60000);
  const padEnd = new Date(end.getTime() + bufferMin * 60000);
  // Fetch a wider window (−4h) so an EARLIER booking that overlaps the padded
  // slot is still returned; the JS overlap check below decides the real conflict.
  const fetchStart = new Date(padStart.getTime() - 4 * 3600 * 1000);
  const [rows] = await pool.execute(
    `SELECT proposed_datetime, duration_minutes FROM viewing_booking
      WHERE status IN (0,1) AND (employee_id = ? OR unit_id = ?)
        AND proposed_datetime >= ? AND proposed_datetime <= ?`,
    [employeeId, unitId, fetchStart, padEnd]
  );
  for (const b of rows) {
    const eStart = new Date(b.proposed_datetime).getTime() - bufferMin * 60000;
    const eEnd = new Date(b.proposed_datetime).getTime() + ((Number(b.duration_minutes) || 30) + bufferMin) * 60000;
    if (start.getTime() < eEnd && end.getTime() > eStart) return { free: false };
  }
  if (calendarId) {
    const busy = await getFreeBusy({ calendarId, timeMin: padStart, timeMax: padEnd });
    const hit = (busy || []).some(w => start.getTime() < new Date(w.end).getTime() && end.getTime() > new Date(w.start).getTime());
    if (hit) return { free: false };
  }
  return { free: true };
}

// ── context load ──────────────────────────────────────────────────────────────
async function loadContext(pool, neg) {
  const [[row]] = await pool.execute(
    `SELECT u.name AS unit_name, p.display_name AS property_name,
            p.street_address, p.city, p.state,
            t.phone AS tenant_phone, t.email AS tenant_email,
            t.first_name AS tenant_first_name, t.last_name AS tenant_last_name, t.company_name
       FROM unit u JOIN property p ON p.id = u.property_id
       LEFT JOIN tenant t ON t.id = ?
      WHERE u.id = ? LIMIT 1`,
    [neg.tenant_id || null, neg.unit_id]
  );
  const ctx = row || {};
  ctx.address = [ctx.street_address, ctx.city, ctx.state].filter(Boolean).join(', ');
  ctx.hasTenant = Boolean(neg.tenant_id);
  return ctx;
}

// ── outbound rendering + dispatch ─────────────────────────────────────────────
const FALLBACKS = {
  'Viewing-Prospect-Day-Ask': `Hi! We'd love to arrange a viewing of %Unit Name% at %Property Name%. Which day and time would suit you? (Viewings run Mon–Sat, 11am–7pm.)`,
  'Viewing-Slot-Taken': `Sorry, %Proposed Time% isn't available. Could you suggest another day and time?`,
  'Viewing-Checking': `Thanks! Let me check on %Proposed Time% for you and confirm the viewing.`,
  'Viewing-Tenant-Ask': `Hi, a prospective viewer would like to see %Unit Name% at %Proposed Time%. Would that be okay?`,
  'Viewing-Tenant-Alt-Ask': `Got it, no problem. May I ask which day and time would work best for you?`,
  'Viewing-Relay-Prospect': `Sorry, %Old Time% doesn't work for the occupant. Would %Proposed Time% work for you instead?`,
  'Viewing-Outside-Hours': `Sorry, %Proposed Time% is outside our viewing hours. Could you suggest another day and time? (Viewings run Mon–Sat, 11am–7pm.)`,
  'Viewing-Relay-Confirmed': `Great news — your viewing of %Unit Name% is confirmed for %Proposed Time%. See you then!`,
  'Viewing-Relay-Escalated': `Thanks for your patience — our team will follow up with you shortly to finalise the viewing.`,
};

async function renderMessage(pool, orgId, templateType, vars) {
  let text = FALLBACKS[templateType] || '';
  try {
    const tpl = await loadTemplate(pool, orgId, templateType);
    if (tpl && tpl.template_content) text = stripToText(tpl.template_content);
  } catch { /* fallback */ }
  return substituteVariables(text, vars || {});
}

// Persist + (auto) send each outbound. Manual mode leaves them as drafts. In
// auto mode we only record 'sent' when the gateway actually DELIVERED it — a
// failed send (or no phone) degrades to a 'draft' so staff see it on the
// dashboard and can retry via Approve & Send, rather than the state machine
// silently believing the party was messaged.
async function dispatchOutbounds(pool, orgId, negId, setting, outbounds) {
  const events = [];
  const auto = setting.relay_mode === 'auto';
  for (const ob of outbounds) {
    const body = await renderMessage(pool, orgId, ob.templateType, ob.vars);
    const id = newId();
    let status = 'draft', sentAt = null;
    if (auto && ob.to_phone) {
      let ok = false;
      try { const r = await sendWhatsApp(pool, orgId, ob.to_phone, body); ok = !!(r && r.ok); }
      catch (e) { console.error('[viewingNegotiation] sendWhatsApp failed:', e.message); }
      if (ok) { status = 'sent'; sentAt = new Date(); }
    }
    await pool.execute(
      `INSERT INTO viewing_negotiation_event
         (id, negotiation_id, direction, party, to_phone, template_type, body, status, sent_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
      [id, negId, ob.party, ob.to_phone || null, ob.templateType, body, status, sentAt]
    );
    events.push({ id, party: ob.party, to_phone: ob.to_phone, template_type: ob.templateType, body, status });
  }
  return events;
}

async function logInbound(pool, negId, party, intent, body, messageId = null) {
  const id = newId();
  const intentJson = intent ? JSON.stringify(intent) : null;
  try {
    await pool.execute(
      `INSERT INTO viewing_negotiation_event (id, negotiation_id, direction, party, body, intent, status, client_message_id)
       VALUES (?, ?, 'in', ?, ?, ?, 'sent', ?)`,
      [id, negId, party, body || null, intentJson, messageId ? String(messageId) : null]
    );
  } catch (e) {
    if (/Unknown column/i.test(e.message)) {
      // pre-migration org — insert without the idempotency column
      await pool.execute(
        `INSERT INTO viewing_negotiation_event (id, negotiation_id, direction, party, body, intent, status)
         VALUES (?, ?, 'in', ?, ?, ?, 'sent')`,
        [id, negId, party, body || null, intentJson]
      );
    } else { throw e; }
  }
}

// ── notifications ──────────────────────────────────────────────────────────────
async function notifyStaff(pool, orgId, title, message) {
  try {
    const { createNotification } = require('./scheduler'); // lazy — avoid require cycle
    await createNotification(pool, { orgId, type: 'viewing', title, message, link: '/property/viewings/negotiations' });
  } catch (e) { console.error('[viewingNegotiation] notifyStaff failed:', e.message); }
}

// ── booking confirmation ──────────────────────────────────────────────────────
async function confirmNegotiation(pool, orgId, neg, whenIso, staff) {
  // Atomically CLAIM the negotiation first: a single UPDATE flips it to CONFIRMED
  // only if it isn't already CONFIRMED/CANCELLED. Two concurrent replies race
  // here; the loser gets affectedRows=0 and MUST NOT create a second booking.
  const [claim] = await pool.execute(
    `UPDATE viewing_negotiation SET state = 'CONFIRMED', awaiting = NULL, closed_at = NOW()
      WHERE id = ? AND state NOT IN ('CONFIRMED', 'CANCELLED')`,
    [neg.id]
  );
  if (claim.affectedRows === 0) return { skipped: true };

  const ctx = await loadContext(pool, neg);
  const whenSql = String(whenIso).slice(0, 19).replace('T', ' '); // MySQL DATETIME literal
  const bookingId = newId();
  const employeeTok = newActionToken();
  const manageTok = newActionToken();
  const icsUid = `${bookingId}@tenafy-viewing`;
  // The negotiation is now claimed CONFIRMED. If the booking insert then fails,
  // COMPENSATE: revert to NEEDS_STAFF so we never leave a "confirmed" negotiation
  // with no booking behind it, and surface it to staff.
  try {
    await getMasterPool().query(
      'INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES ?',
      [[[employeeTok, String(orgId), KIND_ACTION, 1], [manageTok, String(orgId), KIND_MANAGE, 1]]]
    );
    await pool.execute(
      `INSERT INTO viewing_booking (
         id, link_id, unit_id, property_id, employee_id, leasing_id, tenant_id,
         viewer_name, viewer_email, viewer_phone,
         proposed_datetime, duration_minutes,
         tenant_action_token, employee_action_token, viewer_manage_token,
         tenant_decision, employee_decision, status, awaiting, source, ics_uid
       ) VALUES (?, NULL, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, 30,  NULL, ?, ?,  ?, 1, 1, NULL, 'relay', ?)`,
      [bookingId, neg.unit_id, neg.property_id, staff.employee_id,
       neg.lease_id || null, neg.tenant_id || null,
       neg.prospect_name || 'Prospect', neg.prospect_email || '', neg.prospect_phone || null,
       whenSql, employeeTok, manageTok,
       neg.tenant_id ? 1 : 3, icsUid]
    );
    await pool.execute('UPDATE viewing_negotiation SET booking_id = ? WHERE id = ?', [bookingId, neg.id]);
  } catch (e) {
    console.error('[viewingNegotiation] confirm booking insert failed, reverting:', e.message);
    await pool.execute(
      `UPDATE viewing_negotiation SET state = 'NEEDS_STAFF', awaiting = 'staff', booking_id = NULL, closed_at = NULL WHERE id = ?`,
      [neg.id]
    ).catch(() => {});
    notifyStaff(pool, orgId, 'Viewing needs staff',
      `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'}: could not finalise the booking, please complete it manually.`);
    throw e;
  }
  // Joined row for the shared confirmation fan-out (calendar + .ics + emails).
  const [[full]] = await pool.execute(
    `SELECT vb.*, u.name AS unit_name, p.display_name AS property_name,
            p.street_address, p.city, p.state,
            e.email AS employee_email, e.first_name AS employee_first_name,
            e.last_name AS employee_last_name, e.google_calendar_id AS employee_google_calendar_id,
            t.email AS tenant_email, t.first_name AS tenant_first_name,
            t.last_name AS tenant_last_name, t.company_name
       FROM viewing_booking vb
       JOIN unit u ON u.id = vb.unit_id
       JOIN property p ON p.id = vb.property_id
       LEFT JOIN user e ON e.id = vb.employee_id
       LEFT JOIN tenant t ON t.id = vb.tenant_id
      WHERE vb.id = ? LIMIT 1`,
    [bookingId]
  );
  if (full) sendViewingConfirmation(pool, orgId, full);
  return { bookingId, ctx };
}

// ── main entry points ─────────────────────────────────────────────────────────

// Staff pressed "Schedule Viewing". `unit`/`lease` resolved by the caller
// (resolveMarketedUnit). Creates the row + first prospect prompt.
async function startNegotiation(pool, orgId, { unit, lease, prospect }) {
  const setting = await getSetting(pool, orgId);
  // Tenant phone (for the routing block + later tenant leg). Looked up once here.
  let tenantPhone = null;
  const tenantId = lease ? (lease.tenant_id || null) : null;
  if (tenantId) {
    const [[t]] = await pool.execute('SELECT phone FROM tenant WHERE id = ? LIMIT 1', [tenantId]);
    tenantPhone = t ? t.phone : null;
  }
  // Idempotent on a double button-press: reuse an already-open negotiation for
  // the same unit + prospect phone instead of spawning a second relay.
  if (prospect.phone) {
    const [[existing]] = await pool.execute(
      `SELECT id, state, awaiting, prospect_phone FROM viewing_negotiation
        WHERE unit_id = ? AND prospect_phone = ?
          AND state NOT IN ('CONFIRMED', 'CANCELLED', 'NEEDS_STAFF')
        ORDER BY created_at DESC LIMIT 1`,
      [unit.id, prospect.phone]
    );
    if (existing) {
      return {
        negotiation_id: String(existing.id), state: existing.state, awaiting: existing.awaiting,
        events: [], reused: true, ...buildRouting(existing, tenantPhone),
      };
    }
  }
  const negId = newId();
  await pool.execute(
    `INSERT INTO viewing_negotiation
       (id, unit_id, property_id, lease_id, tenant_id, prospect_name, prospect_phone, prospect_email,
        state, awaiting)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ASK_PROSPECT_DAY', 'prospect')`,
    [negId, unit.id, unit.property_id, lease ? lease.id : null, tenantId,
     prospect.name || null, prospect.phone || null, prospect.email || null]
  );
  const vars = { '%Unit Name%': unit.unit_name, '%Property Name%': unit.property_name };
  const events = await dispatchOutbounds(pool, orgId, negId, setting, [
    { party: 'prospect', to_phone: prospect.phone, templateType: 'Viewing-Prospect-Day-Ask', vars },
  ]);
  return {
    negotiation_id: negId, state: 'ASK_PROSPECT_DAY', awaiting: 'prospect', events,
    ...buildRouting({ prospect_phone: prospect.phone || null, awaiting: 'prospect' }, tenantPhone),
  };
}

async function loadNegotiation(pool, negId) {
  const [[row]] = await pool.execute('SELECT * FROM viewing_negotiation WHERE id = ? LIMIT 1', [negId]);
  return row || null;
}

// Apply a parsed inbound reply from `party` ('prospect'|'tenant').
// `messageId` (optional) is TaneChat's WhatsApp message id — if we've already
// processed it for this negotiation we no-op (idempotent), so a duplicate/echo
// inbound or a retried POST can't double-advance the state machine.
async function handleReply(pool, orgId, neg, party, rawIntent, rawText, messageId = null) {
  const setting = await getSetting(pool, orgId);
  const ctx = await loadContext(pool, neg);
  const hasTenant = Boolean(neg.tenant_id);

  if (messageId) {
    try {
      const [[dup]] = await pool.execute(
        `SELECT 1 FROM viewing_negotiation_event WHERE negotiation_id = ? AND client_message_id = ? LIMIT 1`,
        [neg.id, String(messageId)]
      );
      if (dup) {
        return { negotiation: neg, events: [], duplicate: true, ...buildRouting(neg, ctx.tenant_phone) };
      }
    } catch { /* column missing pre-migration — skip dedup */ }
  }

  // Normalize the intent.
  const when = combineDateTime(rawIntent);
  const intent = {
    when: when && !withinWindow(when, setting) ? when : null,
    windowError: when && withinWindow(when, setting) ? withinWindow(when, setting) : null,
    accepted: rawIntent && rawIntent.accepted === true ? true
      : (rawIntent && rawIntent.accepted === false ? false : undefined),
    cancel: Boolean(rawIntent && rawIntent.cancel),
    currentWhen: dateToWallClock(neg.current_proposed_datetime),
  };
  await logInbound(pool, neg.id, party, rawIntent, rawText, messageId);

  const baseVars = {
    '%Unit Name%': ctx.unit_name || '', '%Property Name%': ctx.property_name || '',
    '%Property Address%': ctx.address || '', '%Prospect Name%': neg.prospect_name || '',
  };
  const prospectPhone = neg.prospect_phone;
  const tenantPhone = ctx.tenant_phone;

  // A parseable time that is OUTSIDE the viewing window: tell the sender the
  // reason and keep waiting on them, rather than falling through to the generic
  // "which day?" prompt (which loses why their time was rejected).
  if (intent.windowError && when) {
    const toPhone = party === 'tenant' ? tenantPhone : prospectPhone;
    if (!toPhone) {
      // No way to tell this party why — hand to staff rather than sit silent.
      await pool.execute(`UPDATE viewing_negotiation SET state = 'NEEDS_STAFF', awaiting = 'staff' WHERE id = ?`, [neg.id]);
      notifyStaff(pool, orgId, 'Viewing needs staff',
        `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'} at ${ctx.property_name || ''} (window_no_phone)`);
      const fresh = await loadNegotiation(pool, neg.id);
      return { negotiation: fresh, events: [], ...buildRouting(fresh, ctx.tenant_phone) };
    }
    const events = await dispatchOutbounds(pool, orgId, neg.id, setting, [
      { party, to_phone: toPhone, templateType: 'Viewing-Outside-Hours',
        vars: { ...baseVars, '%Proposed Time%': formatWhen(when) } },
    ]);
    const fresh = await loadNegotiation(pool, neg.id);
    return { negotiation: fresh, events, ...buildRouting(fresh, ctx.tenant_phone) };
  }

  const plan = nextStep({
    state: neg.state, party, intent,
    roundCount: neg.round_count, maxRounds: setting.max_rounds,
  });

  const outbounds = [];
  const set = {}; // columns to update on the negotiation row

  async function doStaffCheck(whenIso, proposedBy, confirmOnFree, roundDelta) {
    const staff = await resolveStaffOfDay(pool, neg.property_id, whenIso);
    if (!staff) {
      return escalatePlan('no_roster', whenIso);
    }
    const { free } = await checkStaffFree(pool, {
      employeeId: staff.employee_id, unitId: neg.unit_id, whenIso,
      buffer: staff.buffer, calendarId: staff.google_calendar_id,
    });
    const vProp = { ...baseVars, '%Proposed Time%': formatWhen(whenIso) };
    if (!free) {
      set.state = 'ASK_PROSPECT_DAY'; set.awaiting = 'prospect';
      outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Slot-Taken', vars: vProp });
      return;
    }
    // Free — lock the proposed time + responsible staffer.
    set.current_proposed_datetime = whenIso.slice(0, 19).replace('T', ' ');
    set.proposed_by = proposedBy;
    set.staff_employee_id = staff.employee_id;
    set.round_count = neg.round_count + (roundDelta || 0);
    if (confirmOnFree || !hasTenant) {
      await confirmAndClose(whenIso, staff, vProp);
      return;
    }
    if (!tenantPhone) {
      // Occupant has no reachable phone — we can't relay to them; hand to staff.
      escalatePlan('tenant_no_phone', whenIso);
      return;
    }
    set.state = 'AWAIT_TENANT'; set.awaiting = 'tenant';
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Checking', vars: vProp });
    outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Tenant-Ask', vars: vProp });
  }

  async function confirmAndClose(whenIso, staff, vProp) {
    const r = await confirmNegotiation(pool, orgId, neg, whenIso, staff);
    if (r && r.skipped) return; // another concurrent reply already closed it — no dup send
    set.state = 'CONFIRMED'; set.awaiting = null; set.closed_at = new Date();
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Relay-Confirmed', vars: vProp });
    if (hasTenant && tenantPhone) {
      outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Relay-Confirmed', vars: vProp });
    }
  }

  function escalatePlan(reason, whenIso) {
    set.state = 'NEEDS_STAFF'; set.awaiting = 'staff';
    const vProp = { ...baseVars, '%Proposed Time%': formatWhen(whenIso || neg.current_proposed_datetime) };
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Relay-Escalated', vars: vProp });
    if (hasTenant && tenantPhone) {
      outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Relay-Escalated', vars: vProp });
    }
    notifyStaff(pool, orgId, 'Viewing needs staff',
      `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'} at ${ctx.property_name || ''} (${reason})`);
  }

  switch (plan.type) {
    case 'reprompt_day':
      set.state = 'ASK_PROSPECT_DAY'; set.awaiting = 'prospect';
      outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Prospect-Day-Ask', vars: baseVars });
      break;
    case 'staff_check':
      await doStaffCheck(plan.when, plan.proposedBy, plan.confirmOnFree, plan.roundDelta);
      break;
    case 'confirm': {
      // Tenant accepted the current proposed time — re-verify the LOCKED staffer
      // (by id, not the roster, which may have changed) is still free.
      const whenIso = intent.currentWhen;
      const staff = await loadStaffById(pool, neg.staff_employee_id);
      if (!staff || !whenIso) { escalatePlan('confirm_no_staff', whenIso); break; }
      const { free } = await checkStaffFree(pool, {
        employeeId: staff.employee_id, unitId: neg.unit_id, whenIso,
        buffer: staff.buffer, calendarId: staff.google_calendar_id,
      });
      if (!free) { escalatePlan('slot_taken_at_confirm', whenIso); break; }
      await confirmAndClose(whenIso, staff, { ...baseVars, '%Proposed Time%': formatWhen(whenIso) });
      break;
    }
    case 'relay_to_prospect': {
      const oldWhen = neg.current_proposed_datetime;
      // Validate the tenant's counter against the staffer on duty THAT day before
      // promising it to the prospect (weekday — and staffer — may differ).
      const staff = await resolveStaffOfDay(pool, neg.property_id, plan.when);
      if (!staff) { escalatePlan('no_roster', plan.when); break; }
      const { free } = await checkStaffFree(pool, {
        employeeId: staff.employee_id, unitId: neg.unit_id, whenIso: plan.when,
        buffer: staff.buffer, calendarId: staff.google_calendar_id,
      });
      if (!free) {
        // No staff available that day → ask the tenant for another time instead
        // of relaying a slot the prospect could accept but we can't honour. Not
        // counted as a round: nothing was relayed to the prospect.
        set.state = 'ASK_TENANT_ALT'; set.awaiting = 'tenant';
        outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Tenant-Alt-Ask', vars: baseVars });
        break;
      }
      set.round_count = neg.round_count + (plan.roundDelta || 0); // count only relayed counters
      set.current_proposed_datetime = plan.when.slice(0, 19).replace('T', ' ');
      set.proposed_by = 'tenant';
      set.staff_employee_id = staff.employee_id;
      set.state = 'RELAY_TO_PROSPECT'; set.awaiting = 'prospect';
      outbounds.push({
        party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Relay-Prospect',
        vars: { ...baseVars, '%Proposed Time%': formatWhen(plan.when), '%Old Time%': formatWhen(oldWhen) },
      });
      break;
    }
    case 'ask_tenant_alt':
      set.state = 'ASK_TENANT_ALT'; set.awaiting = 'tenant';
      outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Tenant-Alt-Ask', vars: baseVars });
      break;
    case 'escalate':
      escalatePlan(plan.reason);
      break;
    case 'cancel':
      set.state = 'CANCELLED'; set.awaiting = null; set.closed_at = new Date();
      break;
    case 'ignore':
    default:
      break; // logged inbound, nothing else
  }

  // Persist negotiation changes with OPTIMISTIC concurrency: only write if the
  // row is still in the state we loaded. If a concurrent reply already advanced
  // or closed it (e.g. a confirm racing a cancel), our stale write is skipped —
  // the confirm path already persisted its result atomically in confirmNegotiation.
  if (Object.keys(set).length) {
    const cols = Object.keys(set);
    await pool.execute(
      `UPDATE viewing_negotiation SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND state = ?`,
      [...cols.map(c => set[c]), neg.id, neg.state]
    );
  }
  const events = await dispatchOutbounds(pool, orgId, neg.id, setting, outbounds);
  const fresh = await loadNegotiation(pool, neg.id);
  return { negotiation: fresh, events, ...buildRouting(fresh, ctx.tenant_phone) };
}

// Staff releases a queued draft outbound (manual mode) → send + mark sent.
async function approveDraft(pool, orgId, eventId) {
  // Atomically CLAIM the draft first so two staff approving at once can't both
  // send it. Only the winner (affectedRows=1) proceeds to send; on send failure
  // we revert to 'draft' so it can be retried.
  const [claim] = await pool.execute(
    `UPDATE viewing_negotiation_event SET status = 'sent', sent_at = NOW()
      WHERE id = ? AND direction = 'out' AND status = 'draft'`,
    [eventId]
  );
  if (claim.affectedRows === 0) return { ok: false, error: 'Draft not found or already sent' };
  const [[ev]] = await pool.execute('SELECT to_phone, body FROM viewing_negotiation_event WHERE id = ?', [eventId]);
  if (ev && ev.to_phone) {
    const r = await sendWhatsApp(pool, orgId, ev.to_phone, ev.body || '');
    if (!r.ok) {
      await pool.execute(`UPDATE viewing_negotiation_event SET status = 'draft', sent_at = NULL WHERE id = ?`, [eventId]);
      return { ok: false, error: r.error || 'Send failed' };
    }
  }
  return { ok: true };
}

// Staff free-form message into either chat (takeover).
async function staffMessage(pool, orgId, neg, partyTo, text) {
  const phone = partyTo === 'tenant'
    ? (await loadContext(pool, neg)).tenant_phone : neg.prospect_phone;
  const id = newId();
  let status = 'draft', sentAt = null;
  if (phone) {
    const r = await sendWhatsApp(pool, orgId, phone, text);
    if (r.ok) { status = 'sent'; sentAt = new Date(); }
  }
  await pool.execute(
    `INSERT INTO viewing_negotiation_event (id, negotiation_id, direction, party, to_phone, body, status, sent_at)
     VALUES (?, ?, 'out', ?, ?, ?, ?, ?)`,
    [id, neg.id, partyTo, phone || null, text, status, sentAt]
  );
  return { ok: status === 'sent', status };
}

async function cancelNegotiation(pool, orgId, neg) {
  await pool.execute(
    `UPDATE viewing_negotiation SET state = 'CANCELLED', awaiting = NULL, closed_at = NOW() WHERE id = ?`,
    [neg.id]
  );
  return { ok: true };
}

// Reaper (hourly cron): open negotiations with no activity for STALE_HOURS are
// escalated to NEEDS_STAFF so an abandoned/looping conversation doesn't sit open
// forever or pollute the /active phone routing. Guarded for pre-migration orgs.
const STALE_HOURS = 24;
async function autoEscalateStaleNegotiationsForOrg(pool, orgId) {
  try {
    const [result] = await pool.execute(
      `UPDATE viewing_negotiation SET state = 'NEEDS_STAFF', awaiting = 'staff'
        WHERE state NOT IN ('CONFIRMED', 'CANCELLED', 'NEEDS_STAFF')
          AND updated_at < DATE_SUB(NOW(), INTERVAL ${STALE_HOURS} HOUR)`
    );
    if (result.affectedRows > 0) {
      console.log(`[Scheduler] Escalated ${result.affectedRows} stale viewing negotiation(s) to staff`);
      notifyStaff(pool, orgId, 'Viewing requests need staff',
        `${result.affectedRows} viewing request(s) had no activity for ${STALE_HOURS}h and were handed to your team.`);
    }
  } catch (err) {
    if (!/doesn't exist|Unknown column|Unknown table/i.test(err.message)) {
      console.error('[Scheduler] stale-negotiation reap failed:', err.message);
    }
  }
}

module.exports = {
  // pure / helpers (tested)
  nextStep, combineDateTime, withinWindow, minutesOf,
  // orchestration
  getSetting, startNegotiation, handleReply, loadNegotiation,
  resolveStaffOfDay, loadStaffById, checkStaffFree, confirmNegotiation,
  approveDraft, staffMessage, cancelNegotiation, loadContext,
  autoEscalateStaleNegotiationsForOrg,
};

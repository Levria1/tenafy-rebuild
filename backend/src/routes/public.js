const express = require('express');
const { orgToday, orgTodaySql, orgWallClock, dbDate } = require('../utils/orgTime');
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
  validateUnitText,
  shouldApplyUnitResolution,
  payloadHash,
} = require('../utils/inquiryFacts');
const { resolveUnit, loadUnitsWithMarketable, unitOut, optionsText } = require('../services/unitResolver');
const { validateChannel } = require('../utils/chatChannel');
const { createNotification } = require('../services/scheduler');
const config = require('../config');
const { buildPostingPlan, markPostingPlan, computeVacancies, loadSettings, findBeyondHorizonNrVacancies } = require('./advertising');
const renewalAsk = require('../utils/renewalAsk');
const { recordRenewalReply } = require('../services/renewalReply');
const {
  deliver: deliverRenewalAsk, openAsks: openRenewalAsks, withConversationLock,
} = require('../services/renewalAskDispatch');
const {
  vacancyToPublicShape,
  classifyFreeOn,
  vacancyFit,
  exceedsHardGapCap,
  exceedsVacantMoveInCutoff,
  vacancyNoMatchReason,
  partnerForwardBlock,
  compareVacancyFit,
  askingRentPublicShape,
  unitDetailDaysToAvailable,
  resolveAvailabilityWindows,
  resolveGapBands,
  resolveInquiryBookingSettings,
  bookingHorizonDecision,
  leaseDurationDays,
  bookingGapLimitForLease,
  matchesBeyondHorizonNrException,
  inquiryGapBandFit,
  hasActiveManualVacancyOverride,
} = require('../utils/advertisingPlan');
const { findUnitByListingUrl, normalizeListingUrl } = require('../utils/listingUrl');

// All public routes require a valid API key (see middleware/apiKeyAuth.js).
// The middleware attaches req.pool (scoped to the caller's org DB) and
// req.apiKey.{id, orgId, name}. Every query below filters by req.apiKey.orgId
// AND runs against req.pool, so multi-tenant isolation is enforced in two places.
router.use(authenticateApiKey);

// Static advertising automation routes must precede the dynamic resource routes.
// Read-only API keys are allowed to fetch a plan; authenticateApiKey rejects the
// mark write for such keys before this handler runs.
router.get('/posting-plan', async (req, res) => {
  try {
    const data = await buildPostingPlan(req.pool, req.apiKey.orgId, { date: req.query.date });
    res.json({ code: 200, data });
  } catch (err) {
    if (err.httpStatus === 400) return res.status(400).json({ code: 400, message: err.message });
    console.error('[public/posting-plan] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to build posting plan' });
  }
});

router.post('/posting-plan/mark', async (req, res) => {
  try {
    const data = await markPostingPlan(req.pool, req.apiKey.orgId, req.body);
    res.json({ code: 200, data });
  } catch (err) {
    if (err.httpStatus === 400) return res.status(400).json({ code: 400, message: err.message });
    console.error('[public/posting-plan mark] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to log post' });
  }
});

const CERTAIN_AVAILABILITY_PHRASE = '{units} available from {date}';
const UNCERTAIN_AVAILABILITY_PHRASE = "We may also have {units} available, however the tenant may renew, they're not sure";
// Deliberately does NOT say why the unit might free up. The occupant has not
// committed to leaving and may well stay; their intention is not a stranger's
// business. "Not confirmed yet" carries the same decision value to a prospect —
// it is uncertain — without disclosing anything about the person living there.
const MANUAL_AVAILABILITY_PHRASE = '{units} may become available from {date} — not confirmed yet.';
// Offered instead of hiding a poor fit: suppressing the unit forfeits the
// negotiation that could remove the vacancy entirely.
const EARLIER_AVAILABILITY_PHRASE = '{units} is free from {date} — would you be able to start a little earlier? We try not to leave a flat empty too long.';
const GAP_ASK_PHRASE = "We're unable to accept a booking that would leave {units} empty for {gap_days} days. Would you be able to move in by {suggested_move_in_date}?";
// The prospect named a date we cannot meet. This offers the date we CAN meet and
// asks — it must never read as though the unit is free on the date they asked for.
const LATER_AVAILABILITY_PHRASE = '{units} available from {date} — a little later than you asked. Would that still work?';

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function isStrictYmd(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Static chatbot availability route. Both phrasing values are templates for the
// caller to fill, not finished sentences.
router.get('/vacancies', async (req, res) => {
  try {
    const maxTier = clampInteger(req.query.max_tier, 3, 1, 3);
    const limit = clampInteger(req.query.limit, 50, 1, 200);
    const propertyId = req.query.property_id != null ? String(req.query.property_id) : null;
    const hasTargetDate = req.query.target_date !== undefined;
    const targetDate = hasTargetDate ? String(req.query.target_date) : null;
    if (hasTargetDate && !isStrictYmd(targetDate)) {
      return res.status(400).json({ code: 400, message: 'target_date must be in YYYY-MM-DD format' });
    }
    const hasFreeOn = req.query.free_on !== undefined;
    const freeOn = hasFreeOn ? String(req.query.free_on) : null;
    if (hasFreeOn && !isStrictYmd(freeOn)) {
      return res.status(400).json({ code: 400, message: 'free_on must be in YYYY-MM-DD format' });
    }
    const hasMoveOut = req.query.move_out !== undefined;
    const moveOut = hasMoveOut ? String(req.query.move_out) : null;
    if (hasMoveOut && !isStrictYmd(moveOut)) {
      return res.status(400).json({ code: 400, message: 'move_out must be in YYYY-MM-DD format' });
    }

    const settings = await loadSettings(req.pool, req.apiKey.orgId);
    const bookingSettings = resolveInquiryBookingSettings(settings);
    const requestDate = hasFreeOn ? freeOn : (hasTargetDate ? targetDate : null);
    const today = orgToday();
    const inquiryGapBands = resolveGapBands(settings, 'inquiry');
    const requestGapBandDays = requestDate
      ? bookingGapLimitForLease(requestDate, hasMoveOut ? moveOut : null, inquiryGapBands)
      : null;
    const requestLeaseDurationDays = requestDate && hasMoveOut
      ? leaseDurationDays(requestDate, moveOut)
      : null;
    const horizon = requestDate
      ? bookingHorizonDecision(requestDate, { today, bookingHorizonDays: bookingSettings.booking_horizon_days })
      : null;
    const enrichGap = row => {
      const fit = vacancyFit(row, requestDate, { today });
      return {
        ...row,
        ...fit,
        ...inquiryGapBandFit({ ...row, ...fit }, requestDate, {
          moveOut: hasMoveOut ? moveOut : null,
          gapBands: inquiryGapBands,
          today,
        }),
      };
    };

    if (horizon?.too_far_out) {
      const rawNrRows = maxTier >= 2
        ? await findBeyondHorizonNrVacancies(req.pool, req.apiKey.orgId, {
          requestDate,
          maxGapDays: settings.hard_max_gap_days,
          propertyId,
          limit,
        })
        : [];
      const rows = rawNrRows
        .map(vacancyToPublicShape)
        .map(enrichGap)
        .filter(row => matchesBeyondHorizonNrException(row, requestDate, settings.hard_max_gap_days))
        .slice(0, limit);
      const noMatchReason = rows.length > 0 ? null : 'too_far_out';
      const data = {
        vacancies: rows,
        count: rows.length,
        hard_max_gap_days: settings.hard_max_gap_days,
        hidden_by_gap_cap: 0,
        no_match_reason: noMatchReason,
        booking_horizon_days: horizon.booking_horizon_days,
        booking_gap_days: requestGapBandDays,
        lease_duration_days: requestLeaseDurationDays,
        partner_forward: { applies: false, message: null },
        phrasing: {
          certain: CERTAIN_AVAILABILITY_PHRASE,
          uncertain: UNCERTAIN_AVAILABILITY_PHRASE,
          earlier: EARLIER_AVAILABILITY_PHRASE,
          gap_ask: settings.inquiry_gap_ask_phrase || GAP_ASK_PHRASE,
        },
      };
      if (hasTargetDate) {
        data.target_date = targetDate;
      }
      data.max_gap_days = settings.max_gap_days;
      if (hasFreeOn) data.free_on = freeOn;
      if (hasMoveOut) data.move_out = moveOut;
      if (noMatchReason === 'too_far_out') {
        data.check_back_in_days = horizon.check_back_in_days;
        data.check_back_on = horizon.check_back_on;
        data.phrasing.too_far_out = bookingSettings.too_far_out_phrase;
      }
      return res.json({ code: 200, data });
    }

    const { vacancies } = await computeVacancies(
      req.pool,
      req.apiKey.orgId,
      { page: false, settings, audience: 'inquiry' }
    );
    let rows = vacancies
      .filter(row => Number(row.tier) <= maxTier)
      .filter(row => !propertyId || String(row.property_id) === propertyId);
    let hiddenByGapCap = 0;
    let hiddenByFreeOn = 0;
    let laterRows = [];

    if (hasTargetDate) {
      // Production Node is UTC. A process-local "today" is still yesterday for
      // the first eight hours of the operator's day, which knocks every tier-1
      // gap_days off by one until 08:00 Hong Kong.
      rows = rows
        .map(vacancyToPublicShape)
        .map(enrichGap)
        .filter(row => {
          if (!exceedsHardGapCap(row, settings.hard_max_gap_days)
              && !exceedsVacantMoveInCutoff(row, settings.vacant_max_move_in_days)) return true;
          hiddenByGapCap += 1;
          return false;
        })
        .sort(compareVacancyFit);
    } else {
      rows = rows
        .map(vacancyToPublicShape);
      if (requestDate) {
        rows = rows
          .map(enrichGap)
          .filter(row => {
            if (!exceedsHardGapCap(row, settings.hard_max_gap_days)
                && !exceedsVacantMoveInCutoff(row, settings.vacant_max_move_in_days)) return true;
            hiddenByGapCap += 1;
            return false;
          });
      }
    }

    if (hasFreeOn) {
      const matchingRows = [];
      for (const row of rows) {
        const freeOnClass = classifyFreeOn(row, freeOn);
        if (freeOnClass === 'match') {
          matchingRows.push(row);
          continue;
        }
        hiddenByFreeOn += 1;
        if (freeOnClass === 'later') laterRows.push(row);
      }
      rows = matchingRows;
      laterRows = laterRows
        .sort((a, b) => {
          const aDate = String(a.availability?.available_from || '');
          const bDate = String(b.availability?.available_from || '');
          if (aDate < bDate) return -1;
          if (aDate > bDate) return 1;
          return String(a.label || '').localeCompare(String(b.label || ''));
        })
        .slice(0, limit);
    }

    rows = rows.slice(0, limit);

    const hasManualRows = rows.some(row => row.source === 'manual');
    const noMatchReason = vacancyNoMatchReason(rows.length, hiddenByGapCap, hiddenByFreeOn);
    const data = {
      vacancies: rows,
      count: rows.length,
      hard_max_gap_days: settings.hard_max_gap_days,
      hidden_by_gap_cap: hiddenByGapCap,
      no_match_reason: noMatchReason,
      // Caller branch point for partner agency forwarding. Use this flag rather
      // than string-matching no_match_reason: the reason is internal reporting.
      // The message is operator-authored outward-facing content; null means the
      // operator has not authored it, so the caller must send nothing.
      partner_forward: partnerForwardBlock(rows.length + laterRows.length, settings.partner_forward_message),
      phrasing: {
        certain: CERTAIN_AVAILABILITY_PHRASE,
        uncertain: UNCERTAIN_AVAILABILITY_PHRASE,
        earlier: EARLIER_AVAILABILITY_PHRASE,
        gap_ask: settings.inquiry_gap_ask_phrase || GAP_ASK_PHRASE,
      },
    };
    if (horizon) data.booking_horizon_days = horizon.booking_horizon_days;
    if (requestDate) {
      data.booking_gap_days = requestGapBandDays;
      data.lease_duration_days = requestLeaseDurationDays;
      data.max_gap_days = settings.max_gap_days;
    }
    if (hasManualRows) data.phrasing.manual = MANUAL_AVAILABILITY_PHRASE;
    if (hasTargetDate) {
      data.target_date = targetDate;
      data.max_gap_days = settings.max_gap_days;
      if (hasMoveOut) data.move_out = moveOut;
    }
    if (hasFreeOn) {
      data.free_on = freeOn;
      if (hasMoveOut) data.move_out = moveOut;
      data.hidden_by_free_on = hiddenByFreeOn;
      if (laterRows.length > 0) {
        data.next_available = laterRows;
        data.phrasing.later = LATER_AVAILABILITY_PHRASE;
      }
    }

    res.json({
      code: 200,
      data,
    });
  } catch (err) {
    console.error('[public/vacancies] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load vacancies' });
  }
});

// Helper: consistent JSON response
// `extra` adds sibling keys beside `data`/`meta` for the rare endpoint that
// returns a second collection. Callers that omit it are unaffected — this is the
// alternative to hand-rolling res.json() at one call site, which then silently
// drifts from this shape the next time the envelope changes.
function ok(res, data, meta, extra) {
  res.json({
    code: 200,
    data,
    meta: { total: Array.isArray(data) ? data.length : undefined, ...(meta || {}) },
    ...(extra || {}),
  });
}
function fail(res, message, status = 500) {
  res.status(status).json({ code: status, message });
}
// Deliberately the resolver's own formatter, not a copy of it — see the note on
// its export.
const publicUnitOut = unitOut;
function badResolveField(body) {
  for (const key of ['unit_id', 'listing_url', 'listing_link', 'unit_text']) {
    if (body[key] != null && typeof body[key] !== 'string') return key;
  }
  return null;
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({
    // Compared back against raw DATETIME/TIMESTAMP digits in SQL. Operator-zone
    // rendering here would skip or repeat a page of rows.
    updated_at: viewingNegotiation.dateToWallClock(row.updated_at),
    id: String(row.id),
  })).toString('base64url');
}
function decodeCursor(s) {
  if (!s) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (!parsed || !parsed.updated_at || parsed.id == null) return null;
    return { updated_at: String(parsed.updated_at).slice(0, 19).replace('T', ' '), id: String(parsed.id) };
  } catch { return null; }
}
function tenantName(row) {
  return row.tenant_company_name || [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ') || null;
}
function boardRow(row, lastEvent, setting) {
  const terminal = viewingNegotiation.TERMINAL_STATES.includes(row.state);
  const next = viewingNegotiation.boardNextDeadline(row, setting, new Date());
  const flags = [];
  if (row.state === 'AWAIT_TENANT' && row.awaiting === 'tenant' && !row.policy_explicit_confirm && row.tenant_notified_at) flags.push('implicit_consent_pending');
  if (next.overdue) flags.push('overdue');
  if ([viewingNegotiation.STATE_TENANT_REVERSED, viewingNegotiation.STATE_RESCHEDULE_AFTER_COMMIT].includes(row.state)) flags.push('reversal');
  if (row.policy_explicit_confirm) flags.push('explicit_yes_required');
  return {
    negotiation_id: String(row.id),
    status: terminal ? 'terminal' : 'active',
    state: row.state || null,
    needs_staff_reason: row.needs_staff_reason || null,
    awaiting: row.awaiting || null,
    unit: {
      id: row.unit_id == null ? null : String(row.unit_id),
      label: [row.property_name, row.unit_name].filter(Boolean).join(' ') || null,
      address: [row.street_address, row.city, row.state_name].filter(Boolean).join(', ') || null,
    },
    customer: { name: row.prospect_name || null, phone: row.prospect_phone || null },
    tenant: {
      id: row.tenant_id == null ? null : String(row.tenant_id),
      name: tenantName(row),
      phone: row.tenant_phone || null,
    },
    viewing: {
      // Appointment DATETIME already holds Hong Kong digits. Converting the
      // instant mysql2 built from them would slide an evening viewing to the
      // next calendar day.
      proposed_start_at: viewingNegotiation.dateToWallClock(row.current_proposed_datetime),
      timezone: 'Asia/Hong_Kong',
    },
    policy: {
      opt_out_window_hours: row.policy_opt_out_hours == null ? null : Number(row.policy_opt_out_hours),
      require_explicit_confirmation: row.policy_explicit_confirm == null ? null : Boolean(row.policy_explicit_confirm),
      source: row.policy_source || null,
    },
    timestamps: {
      // TIMESTAMP / NOW()-written DATETIME: mysql2's Date is a real instant, so
      // re-emitting local digits publishes UTC while this payload claims Hong Kong.
      created_at: row.created_at ? orgWallClock(row.created_at) : null,
      customer_asked_at: row.customer_asked_at ? orgWallClock(row.customer_asked_at) : null,
      tenant_notified_at: row.tenant_notified_at ? orgWallClock(row.tenant_notified_at) : null,
      auto_confirmed_at: row.auto_confirmed_at ? orgWallClock(row.auto_confirmed_at) : null,
      updated_at: row.updated_at ? orgWallClock(row.updated_at) : null,
    },
    next_deadline: next,
    risk_flags: flags,
    last_event: lastEvent ? {
      event_type: lastEvent.event_type || null,
      party: lastEvent.party || null,
      send_mode: lastEvent.send_mode || null,
      status: lastEvent.status || null,
      created_at: lastEvent.created_at ? orgWallClock(lastEvent.created_at) : null,
    } : { event_type: null, party: null, send_mode: null, status: null, created_at: null },
  };
}
function draftRow(row) {
  const hasUnit = row.unit_id != null && row.unit_name;
  const out = {
    event_id: row.event_id == null ? null : String(row.event_id),
    negotiation_id: row.negotiation_id == null ? null : String(row.negotiation_id),
    negotiation_state: row.negotiation_state || null,
    awaiting: row.awaiting || null,
    party: row.party || null,
    to_phone: row.to_phone || null,
    body: row.body || null,
    template_type: row.template_type || null,
    event_type: row.event_type || null,
    send_mode: row.send_mode || null,
    idempotency_key: row.idempotency_key || null,
    deadline_at: row.deadline_at ? orgWallClock(row.deadline_at) : null,
    created_at: row.created_at ? orgWallClock(row.created_at) : null,
    expires_at: row.expires_at ? orgWallClock(row.expires_at) : null,
    age_hours: row.age_hours == null ? null : Number(row.age_hours),
    unit: {
      id: row.unit_id == null ? null : String(row.unit_id),
      label: hasUnit ? [row.property_name, row.unit_name].filter(Boolean).join(' ') : null,
    },
    customer: { name: row.prospect_name || null, phone: row.prospect_phone || null },
  };
  return out;
}

function safeParseCandidates(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function nothingToSend(res, state) {
  return res.status(409).json({ code: 409, reason: 'nothing_to_send', state });
}

function requireVars(vars, names) {
  return names.every((name) => vars[name] != null && String(vars[name]).trim() !== '');
}

function requiredVarsForTemplate(templateType) {
  switch (templateType) {
    case 'Viewing-Choose-Unit':
      return ['%Unit Options%'];
    case 'Viewing-Confirm-Unit':
      return ['%Unit Full Name%'];
    case 'Viewing-Prospect-Day-Ask':
      return ['%Unit Name%', '%Property Name%'];
    case 'Viewing-Confirm-Time':
      return ['%Unit Name%', '%Property Name%', '%Proposed Time%'];
    case 'Viewing-Relay-Prospect':
      return ['%Proposed Time%'];
    case 'Viewing-Tenant-Ask':
      return ['%Unit Name%', '%Property Name%', '%Proposed Time%', '%Name - Lease%'];
    default:
      return [];
  }
}

async function selectDraftForResponse(pool, eventId) {
  const [[row]] = await pool.execute(
    `SELECT e.id AS event_id, e.negotiation_id, n.state AS negotiation_state,
            n.awaiting, e.party, e.to_phone, e.body, e.template_type,
            e.event_type, e.send_mode, e.idempotency_key, e.deadline_at,
            e.created_at, DATE_ADD(e.created_at, INTERVAL ${viewingNegotiation.DRAFT_FRESH_MINUTES} MINUTE) AS expires_at,
            TIMESTAMPDIFF(HOUR, e.created_at, NOW()) AS age_hours,
            n.unit_id, n.prospect_name, n.prospect_phone,
            u.name AS unit_name, p.display_name AS property_name
       FROM viewing_negotiation_event e
       JOIN viewing_negotiation n ON n.id = e.negotiation_id
       LEFT JOIN unit u ON u.id = n.unit_id
       LEFT JOIN property p ON p.id = n.property_id
      WHERE e.id = ? LIMIT 1`,
    [eventId]
  );
  return row || null;
}

const MAX_FACTS = 50;
const MAX_FACT_CHARS = 500;
// BYTES, not characters: `inquiry.notes` is TEXT (65,535 bytes) and utf8mb4
// Chinese costs 3 bytes per character. Compared with Buffer.byteLength.
const MAX_NOTES_BYTES = 60000;
const MONEY_FACT_FIELDS = new Set(['budget', 'nightly_rate', 'stay_total']);
const INQUIRY_FACT_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'reservation_code',
  'budget',
  'desired_start_date',
  'desired_end_date',
  'nightly_rate',
  'stay_total',
];

// `applied` means the delivery was ACCEPTED and processed — not that any field
// changed. A field already carrying a human (or pre-cutover Tenafy) value is
// declined by provenance, and a summary is only used to seed empty notes. Both
// are silent from the caller's side, so they are reported explicitly:
// `skipped_fields` lists fields we refused to overwrite, and `summary_applied`
// says whether the summary was used. Additive keys — the original five are
// always present and unchanged.
// `facts_applied` / `facts_skipped` exist because facts can be dropped for reasons
// the caller cannot see: a fact already recorded is not written twice, and a full
// notes column stops taking them. `reason` may therefore be set WITH applied:true,
// meaning the delivery was accepted but part of it did not land.
function inquiryFactResponse({
  inquiryId = null, created = false, applied = false, reason = null, supersededInquiryId = null,
  skippedFields = [], summaryApplied = false, factsApplied = 0, factsSkipped = 0,
  unitResolution = null,
}) {
  return {
    inquiry_id: inquiryId == null ? null : String(inquiryId),
    created,
    applied,
    reason,
    superseded_inquiry_id: supersededInquiryId == null ? null : String(supersededInquiryId),
    skipped_fields: Array.isArray(skippedFields) ? skippedFields : [],
    summary_applied: !!summaryApplied,
    facts_applied: factsApplied,
    facts_skipped: factsSkipped,
    unit_resolution: unitResolution,
  };
}

const MAX_SUMMARY_CHARS = 2000;

function validateInquiryFactRequest(body, { requireIsInquiry = false, allowFacts = true } = {}) {
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
  const channelResult = validateChannel(b.channel);
  if (!channelResult.ok) return { ok: false, error: channelResult.error };
  // channel_user_id IS the session identity — UNIQUE(channel, channel_user_id). A
  // whitespace-only or absurd value is not a 500 waiting to happen, it is a COLLAPSE:
  // every caller without a real identity lands on the same session and inherits a
  // stranger's inquiry. The presence check above stops '' but not '   '. 255 is the
  // column width, and sql_mode is STRICT, so an over-length value would 500.
  const cuid = String(b.channel_user_id).trim();
  if (!cuid) return { ok: false, error: 'channel_user_id is required' };
  if (cuid.length > 255) return { ok: false, error: 'channel_user_id_too_long' };
  if (b.facts !== undefined && !Array.isArray(b.facts)) return { ok: false, error: 'facts_must_be_array' };
  const facts = Array.isArray(b.facts) ? b.facts : [];
  if (facts.length > MAX_FACTS) return { ok: false, error: 'too_many_facts' };
  for (const fact of facts) {
    if (String(fact).length > MAX_FACT_CHARS) return { ok: false, error: 'fact_too_long' };
  }
  // from-chat has no notes-append path, so accepting facts there would validate them
  // and then silently drop them while returning applied:true. Refuse instead.
  if (!allowFacts && facts.length) return { ok: false, error: 'facts_not_allowed_here' };
  // summary lands in a TEXT column. Unvalidated, an object becomes the literal
  // "[object Object]" and a huge string 500s the INSERT.
  if (b.summary !== undefined && b.summary !== null) {
    if (typeof b.summary !== 'string') return { ok: false, error: 'invalid_summary' };
    if (b.summary.length > MAX_SUMMARY_CHARS) return { ok: false, error: 'summary_too_long' };
  }
  const fieldsResult = validateFields(b.fields);
  if (!fieldsResult.ok) return { ok: false, error: fieldsResult.error };
  const unitTextResult = validateUnitText(b.unit_text);
  if (!unitTextResult.ok) return { ok: false, error: unitTextResult.error };
  return { ok: true, channel: channelResult.channel, facts, fields: fieldsResult.fields, unitText: unitTextResult.unitText };
}

function unitResolutionResponse(resolution, applied) {
  if (!resolution) return null;
  const match = resolution.match || null;
  const candidates = ['ambiguous', 'property_only', 'multi_unit'].includes(resolution.status)
    ? (resolution.candidates || []).map(c => ({
        unit_id: c && c.unit_id != null ? String(c.unit_id) : null,
        label: c ? c.label || null : null,
      }))
    : [];
  return {
    status: resolution.status,
    unit_id: match && match.unit_id != null ? String(match.unit_id) : null,
    property_id: match && match.property_id != null ? String(match.property_id) : null,
    label: match ? match.label || null : null,
    applied: !!applied,
    candidates,
  };
}

// Hand back the stored response object untouched, so a retry is byte-identical to
// the first answer. Rebuilding it from scalars cannot work: for an `ambiguous`
// resolution the payload the caller actually needs IS the candidate list.
function priorUnitResolutionResponse(prior) {
  if (!prior || prior.unit_resolution_json == null) return null;
  if (typeof prior.unit_resolution_json === 'object') return prior.unit_resolution_json;
  try {
    return JSON.parse(prior.unit_resolution_json);
  } catch {
    // A JSON column cannot normally hold unparseable text, but a null-vs-garbage
    // surprise must not turn a replay into a 500 — the delivery already happened.
    console.warn('[inquiry-facts] unreadable unit_resolution_json on replay');
    return null;
  }
}

async function registerChannel(conn, orgId, channel) {
  const [result] = await conn.execute(
    `INSERT INTO chat_channel (id, org_id, channel, delivery_count)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE delivery_count = delivery_count + 1`,
    [newId(), orgId, channel]
  );
  return Number(result.affectedRows) === 1;
}

async function notifyNewChannel(conn, orgId, channel) {
  await createNotification(conn, {
    orgId,
    type: 'warning',
    title: `New chat channel: ${channel}`,
    message:
      `A conversation arrived on channel "${channel}", which has never been seen before. ` +
      'It has been accepted and registered. If this name looks like a typo, correct it at source promptly because sessions created under it are a separate identity from the corrected name.',
    link: '/chatbot/sessions',
  });
}

async function updateDeliveryOutcome(conn, orgId, idempotencyKey, outcome) {
  await conn.execute(
    `UPDATE inquiry_fact_delivery
        SET inquiry_id = ?, applied = ?, created = ?, superseded_inquiry_id = ?, reason = ?,
            facts_json = ?, fields_json = ?, summary_text = ?, summary_applied = ?, skipped_json = ?,
            facts_applied = ?, facts_skipped = ?, unit_text = ?, unit_resolution_json = ?
      WHERE org_id = ? AND idempotency_key = ?`,
    [
      outcome.inquiryId == null ? null : outcome.inquiryId,
      outcome.applied ? 1 : 0,
      outcome.created ? 1 : 0,
      outcome.supersededInquiryId == null ? null : outcome.supersededInquiryId,
      outcome.reason || null,
      JSON.stringify(Array.isArray(outcome.facts) ? outcome.facts : []),
      JSON.stringify(outcome.fields && typeof outcome.fields === 'object' ? outcome.fields : {}),
      outcome.summary == null || outcome.summary === '' ? null : String(outcome.summary),
      outcome.summaryApplied ? 1 : 0,
      JSON.stringify(Array.isArray(outcome.skippedFields) ? outcome.skippedFields : []),
      Number(outcome.factsApplied) || 0,
      Number(outcome.factsSkipped) || 0,
      outcome.unitText == null ? null : String(outcome.unitText),
      outcome.unitResolution == null ? null : JSON.stringify(outcome.unitResolution),
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
      `SELECT inquiry_id, applied, created, superseded_inquiry_id, reason, payload_hash,
              summary_applied, skipped_json, facts_applied, facts_skipped,
              unit_text, unit_resolution_json
         FROM inquiry_fact_delivery
        WHERE org_id = ? AND idempotency_key = ?
        LIMIT 1`,
      [orgId, idempotencyKey]
    );
    return prior;
  }
}

// A replay must report the SAME outcome the first delivery reported, including
// which fields were declined — otherwise a retry looks like a different result.
function priorDeliveryResponse(prior) {
  let skipped = prior.skipped_json;
  if (typeof skipped === 'string') {
    try { skipped = JSON.parse(skipped); } catch (e) { skipped = []; }
  }
  return inquiryFactResponse({
    inquiryId: prior.inquiry_id,
    created: Number(prior.created) === 1,
    applied: Number(prior.applied) === 1,
    reason: prior.reason || null,
    supersededInquiryId: prior.superseded_inquiry_id,
    skippedFields: Array.isArray(skipped) ? skipped : [],
    summaryApplied: Number(prior.summary_applied) === 1,
    factsApplied: Number(prior.facts_applied) || 0,
    factsSkipped: Number(prior.facts_skipped) || 0,
    unitResolution: priorUnitResolutionResponse(prior),
  });
}

async function loadLockedInquiryForFacts(conn, orgId, inquiryId) {
  const [[row]] = await conn.execute(
    `SELECT i.id, i.status, i.tenant_id, i.notes, i.api_set_fields, i.unit_id, i.property_id,
            i.reservation_code,
            i.first_name, i.last_name, i.email, i.phone, i.budget, i.nightly_rate, i.stay_total,
            DATE_FORMAT(i.desired_start_date, '%Y-%m-%d') AS desired_start_date,
            DATE_FORMAT(i.desired_end_date, '%Y-%m-%d') AS desired_end_date,
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
  return { writable: resolved.writable, writtenNames, apiSetFields, skipped: resolved.skipped };
}

async function createInquiryFromFactPayload(conn, orgId, session, channel, fields, summary, unitAssignment = null) {
  const inquiryId = newId();
  const values = {
    first_name: fields.first_name || null,
    last_name: fields.last_name || null,
    email: fields.email || (channel === 'email' ? String(session.channel_user_id).toLowerCase() : null),
    phone: fields.phone || (channel === 'whatsapp' ? String(session.channel_user_id) : null),
    reservation_code: fields.reservation_code || null,
    budget: fields.budget != null ? Number(fields.budget) : null,
    desired_start_date: fields.desired_start_date || null,
    desired_end_date: fields.desired_end_date || null,
    nightly_rate: fields.nightly_rate != null ? Number(fields.nightly_rate) : null,
    stay_total: fields.stay_total != null ? Number(fields.stay_total) : null,
  };
  const unitId = unitAssignment && unitAssignment.unit_id != null ? unitAssignment.unit_id : null;
  const propertyId = unitAssignment && unitAssignment.property_id != null ? unitAssignment.property_id : null;
  const written = INQUIRY_FACT_FIELDS.filter(field => values[field] !== null && values[field] !== undefined && values[field] !== '');
  if (unitId != null) written.push('unit_id');
  await conn.execute(
    `INSERT INTO inquiry
       (id, org_id, inquiry_date, first_name, last_name, email, phone,
        notes, api_set_fields, source, status, desired_start_date, desired_end_date,
        budget, nightly_rate, stay_total, reservation_code, unit_id, property_id)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      values.desired_end_date,
      values.budget,
      values.nightly_rate,
      values.stay_total,
      values.reservation_code,
      unitId,
      propertyId,
    ]
  );
  await conn.execute(
    `UPDATE chat_session
        SET inquiry_id = ?, lead_captured = 1
      WHERE id = ?`,
    [inquiryId, session.id]
  );
  // A brand-new row has nothing to overwrite, so nothing can be declined and the
  // summary always lands.
  return { inquiryId, skipped: [], summaryApplied: !!summary };
}

async function applyFieldsAndSummaryToInquiry(conn, orgId, row, fields, summary, unitResolution = null) {
  const sets = [];
  const params = [];
  const { writable, writtenNames, apiSetFields, skipped } = buildFieldAssignments(fields, row);
  let nextApiSetFields = apiSetFields;
  let unitApplied = false;
  const summaryApplied = !!(summary && !(row.notes && String(row.notes).trim()));
  if (summaryApplied) {
    sets.push('notes = ?');
    params.push(String(summary));
  }
  if (unitResolution && shouldApplyUnitResolution({
    status: unitResolution.status,
    currentUnitId: row.unit_id,
    apiSetFields: row.api_set_fields,
  })) {
    unitApplied = true;
    nextApiSetFields = mergeApiSetFields(nextApiSetFields, ['unit_id']);
    sets.push('unit_id = ?', 'property_id = ?');
    params.push(unitResolution.match.unit_id, unitResolution.match.property_id);
  }
  sets.push('api_set_fields = ?');
  params.push(JSON.stringify(nextApiSetFields));
  for (const field of writtenNames) {
    sets.push(`${field} = ?`);
    params.push(MONEY_FACT_FIELDS.has(field) ? Number(writable[field]) : writable[field]);
  }
  sets.push('updated_at = NOW()');
  await conn.execute(`UPDATE inquiry SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [...params, row.id, orgId]);
  return { writtenNames, skipped, summaryApplied, unitApplied };
}

// POST /api/public/inquiry/from-chat
router.post('/inquiry/from-chat', async (req, res) => {
  const checked = validateInquiryFactRequest(req.body, { requireIsInquiry: true, allowFacts: false });
  if (!checked.ok) return fail(res, checked.error, 400);

  let conn;
  try {
    const orgId = req.apiKey.orgId;
    const b = { ...(req.body || {}), channel: checked.channel };
    const channel = checked.channel;
    const channelUserId = String(b.channel_user_id);
    const idempotencyKey = String(b.idempotency_key);
    const hash = payloadHash(b);

    conn = await req.pool.getConnection();
    await conn.beginTransaction();

    const prior = await claimInquiryFactDelivery(conn, orgId, idempotencyKey, hash);
    if (prior) {
      await conn.commit();
      if (prior.payload_hash !== hash) return fail(res, 'idempotency_key_conflict', 409);
      return ok(res, priorDeliveryResponse(prior));
    }

    const firstChannelSeen = await registerChannel(conn, orgId, channel);
    if (firstChannelSeen) await notifyNewChannel(conn, orgId, channel);

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
        facts: checked.facts,
        fields: checked.fields,
        summary: b.summary,
      });
      await conn.commit();
      return ok(res, outcome);
    }

    let outcome;
    if (!session.inquiry_id) {
      let unitResolution = null;
      if (checked.unitText) unitResolution = await resolveUnit(conn, orgId, checked.unitText);
      const unitApplied = unitResolution && shouldApplyUnitResolution({
        status: unitResolution.status,
        currentUnitId: null,
        apiSetFields: null,
      });
      const made = await createInquiryFromFactPayload(
        conn,
        orgId,
        session,
        channel,
        checked.fields,
        b.summary,
        unitApplied ? unitResolution.match : null
      );
      outcome = inquiryFactResponse({
        inquiryId: made.inquiryId, created: true, applied: true,
        skippedFields: made.skipped, summaryApplied: made.summaryApplied,
        unitResolution: unitResolutionResponse(unitResolution, unitApplied),
      });
    } else {
      const gate = await loadLockedInquiryForFacts(conn, orgId, session.inquiry_id);
      if (!gate.reason) {
        let unitResolution = null;
        if (checked.unitText) unitResolution = await resolveUnit(conn, orgId, checked.unitText);
        const applied = await applyFieldsAndSummaryToInquiry(conn, orgId, gate.row, checked.fields, b.summary, unitResolution);
        outcome = inquiryFactResponse({
          inquiryId: gate.row.id, created: false, applied: true,
          skippedFields: applied.skipped, summaryApplied: applied.summaryApplied,
          unitResolution: unitResolutionResponse(unitResolution, applied.unitApplied),
        });
      } else if (gate.reason === 'inquiry_closed' || gate.reason === 'inquiry_converted') {
        let unitResolution = null;
        if (checked.unitText) unitResolution = await resolveUnit(conn, orgId, checked.unitText);
        const unitApplied = unitResolution && shouldApplyUnitResolution({
          status: unitResolution.status,
          currentUnitId: null,
          apiSetFields: null,
        });
        const made = await createInquiryFromFactPayload(
          conn,
          orgId,
          session,
          channel,
          checked.fields,
          b.summary,
          unitApplied ? unitResolution.match : null
        );
        outcome = inquiryFactResponse({
          inquiryId: made.inquiryId,
          created: true,
          applied: true,
          supersededInquiryId: session.inquiry_id,
          skippedFields: made.skipped,
          summaryApplied: made.summaryApplied,
          unitResolution: unitResolutionResponse(unitResolution, unitApplied),
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
      created: outcome.created,
      supersededInquiryId: outcome.superseded_inquiry_id,
      reason: outcome.reason,
      facts: checked.facts,
      fields: checked.fields,
      summary: b.summary,
      summaryApplied: outcome.summary_applied,
      skippedFields: outcome.skipped_fields,
      unitText: checked.unitText,
      unitResolution: outcome.unit_resolution,
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
    const b = { ...(req.body || {}), channel: checked.channel };
    const channel = checked.channel;
    const channelUserId = String(b.channel_user_id);
    const idempotencyKey = String(b.idempotency_key);
    const hash = payloadHash(b);

    conn = await req.pool.getConnection();
    await conn.beginTransaction();

    const prior = await claimInquiryFactDelivery(conn, orgId, idempotencyKey, hash);
    if (prior) {
      await conn.commit();
      if (prior.payload_hash !== hash) return fail(res, 'idempotency_key_conflict', 409);
      return ok(res, priorDeliveryResponse(prior));
    }

    const firstChannelSeen = await registerChannel(conn, orgId, channel);
    if (firstChannelSeen) await notifyNewChannel(conn, orgId, channel);

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
        facts: checked.facts,
        fields: checked.fields,
        summary: b.summary,
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
        facts: checked.facts,
        fields: checked.fields,
        summary: b.summary,
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
        facts: checked.facts,
        fields: checked.fields,
        summary: b.summary,
      });
      await conn.commit();
      return ok(res, outcome);
    }

    const row = gate.row;
    const sets = [];
    const params = [];
    let unitResolution = null;
    let unitApplied = false;
    let factsApplied = 0;
    let factsSkipped = 0;
    let notesReason = null;
    if (checked.unitText) unitResolution = await resolveUnit(conn, orgId, checked.unitText);
    if (checked.facts.length) {
      const appended = appendFactsToNotes(row.notes, checked.facts, hkDate(b.occurred_at));
      // A full notes column must NOT become a dead end. Throwing here rolled the
      // transaction back, which released the idempotency claim, so the caller's
      // retry hit the same limit and the conversation was stuck on 413 forever.
      // Instead: skip the notes append, still apply the fields, and say so — the
      // delivery is recorded, the key is consumed, and the retry loop ends.
      if (Buffer.byteLength(appended.notes, 'utf8') > MAX_NOTES_BYTES) {
        notesReason = 'notes_limit_reached';
        factsSkipped = checked.facts.length;
        console.warn(
          `[inquiry-facts] notes at capacity for inquiry ${row.id} (org ${orgId}); ` +
          `${checked.facts.length} fact(s) not recorded. The field needs trimming.`
        );
      } else {
        factsApplied = appended.applied;
        factsSkipped = appended.skipped;
        if (appended.applied > 0) {
          sets.push('notes = ?');
          params.push(appended.notes);
        }
      }
    }

    const { writable, writtenNames, apiSetFields, skipped } = buildFieldAssignments(checked.fields, row);
    let nextApiSetFields = apiSetFields;
    if (unitResolution && shouldApplyUnitResolution({
      status: unitResolution.status,
      currentUnitId: row.unit_id,
      apiSetFields: row.api_set_fields,
    })) {
      unitApplied = true;
      nextApiSetFields = mergeApiSetFields(nextApiSetFields, ['unit_id']);
      sets.push('unit_id = ?', 'property_id = ?');
      params.push(unitResolution.match.unit_id, unitResolution.match.property_id);
    }
    if (writtenNames.length || unitApplied) {
      sets.push('api_set_fields = ?');
      params.push(JSON.stringify(nextApiSetFields));
      for (const field of writtenNames) {
        sets.push(`${field} = ?`);
        params.push(MONEY_FACT_FIELDS.has(field) ? Number(writable[field]) : writable[field]);
      }
    }

    if (sets.length) {
      sets.push('updated_at = NOW()');
      await conn.execute(
        `UPDATE inquiry SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`,
        [...params, row.id, orgId]
      );
    }

    // This endpoint appends dated fact lines; it never seeds notes from `summary`
    // (that is first-contact behaviour, and here it would fight the append). A
    // summary sent to /facts is therefore recorded but NOT applied — reported as
    // summary_applied:false rather than dropped in silence.
    const outcome = inquiryFactResponse({
      inquiryId: row.id, created: false, applied: true,
      skippedFields: skipped, summaryApplied: false,
      factsApplied, factsSkipped, reason: notesReason,
      unitResolution: unitResolutionResponse(unitResolution, unitApplied),
    });
    await updateDeliveryOutcome(conn, orgId, idempotencyKey, {
      inquiryId: row.id,
      applied: true,
      reason: notesReason,
      facts: checked.facts,
      fields: checked.fields,
      summary: b.summary,
      summaryApplied: false,
      skippedFields: skipped,
      factsApplied,
      factsSkipped,
      unitText: checked.unitText,
      unitResolution: outcome.unit_resolution,
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
          AND start_date <= ${orgTodaySql()} AND (end_date >= ${orgTodaySql()} OR end_date IS NULL)
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
        AND start_date <= ${orgTodaySql()} AND (end_date >= ${orgTodaySql()} OR end_date IS NULL)
      ORDER BY start_date DESC LIMIT 1`,
    [unitId]
  );
  // Occupied + opted in → marketable (the tenant will be asked).
  if (lease && Number(lease.viewing_enabled)) return { unit, lease };
  if (await hasActiveManualVacancyOverride(pool, orgId, unitId)) return { unit, lease };
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

// GET /api/public/viewing-negotiations
// Board API for TaneChat: plural route is separate from the strict singular
// /viewing-negotiation/active phone-routing response.
router.get('/viewing-negotiations', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const setting = await viewingNegotiation.getSetting(req.pool, orgId);
    const status = ['active', 'terminal', 'all'].includes(req.query.status) ? req.query.status : 'active';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = ['n.org_id = ?'];
    const params = [orgId];
    if (status === 'active') where.push(`n.state NOT IN (${viewingNegotiation.TERMINAL_STATES.map(() => '?').join(',')})`), params.push(...viewingNegotiation.TERMINAL_STATES);
    if (status === 'terminal') where.push(`n.state IN (${viewingNegotiation.TERMINAL_STATES.map(() => '?').join(',')})`), params.push(...viewingNegotiation.TERMINAL_STATES);
    if (req.query.state) {
      const states = String(req.query.state).split(',').map(s => s.trim()).filter(Boolean);
      if (states.length) {
        where.push(`n.state IN (${states.map(() => '?').join(',')})`);
        params.push(...states);
      }
    }
    if (req.query.updated_since) {
      where.push('n.updated_at >= ?');
      params.push(String(req.query.updated_since).slice(0, 19).replace('T', ' '));
    }
    const cursor = decodeCursor(req.query.cursor);
    if (cursor) {
      where.push('(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))');
      params.push(cursor.updated_at, cursor.updated_at, cursor.id);
    }
    let rows;
    try {
      [rows] = await req.pool.execute(
        `SELECT n.id, n.state, n.awaiting, n.unit_id, n.tenant_id, n.prospect_name, n.prospect_phone,
                n.current_proposed_datetime, n.needs_staff_reason, n.policy_opt_out_hours, n.policy_explicit_confirm,
                n.policy_source, n.customer_asked_at, n.tenant_notified_at, n.auto_confirmed_at,
                n.opt_out_deadline_at, n.customer_nudge_count, n.tenant_nudge_count, n.last_nudge_at,
                n.created_at, n.updated_at,
                u.name AS unit_name, p.display_name AS property_name, p.street_address, p.city, p.state AS state_name,
                t.phone AS tenant_phone, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                t.company_name AS tenant_company_name
           FROM viewing_negotiation n
           LEFT JOIN unit u ON u.id = n.unit_id
           LEFT JOIN property p ON p.id = n.property_id
           LEFT JOIN tenant t ON t.id = n.tenant_id
          WHERE ${where.join(' AND ')}
          ORDER BY n.updated_at DESC, n.id DESC
          LIMIT ${limit + 1}`,
        params
      );
    } catch (e) {
      if (!viewingNegotiation.isSchemaMissingError(e)) throw e;
      [rows] = await req.pool.execute(
        `SELECT n.id, n.state, n.awaiting, n.unit_id, n.tenant_id, n.prospect_name, n.prospect_phone,
                n.current_proposed_datetime, NULL AS needs_staff_reason,
                NULL AS policy_opt_out_hours, NULL AS policy_explicit_confirm, NULL AS policy_source,
                NULL AS customer_asked_at, NULL AS tenant_notified_at, NULL AS auto_confirmed_at,
                NULL AS opt_out_deadline_at, NULL AS customer_nudge_count, NULL AS tenant_nudge_count,
                NULL AS last_nudge_at, n.created_at, n.updated_at,
                u.name AS unit_name, p.display_name AS property_name, p.street_address, p.city, p.state AS state_name,
                t.phone AS tenant_phone, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                t.company_name AS tenant_company_name
           FROM viewing_negotiation n
           LEFT JOIN unit u ON u.id = n.unit_id
           LEFT JOIN property p ON p.id = n.property_id
           LEFT JOIN tenant t ON t.id = n.tenant_id
          WHERE ${where.join(' AND ')}
          ORDER BY n.updated_at DESC, n.id DESC
          LIMIT ${limit + 1}`,
        params
      );
    }
    const pageRows = rows.slice(0, limit);
    const lastByNegotiation = new Map();
    if (pageRows.length) {
      const ids = pageRows.map(r => String(r.id));
      try {
        const [events] = await req.pool.execute(
          `SELECT e.negotiation_id, e.event_type, e.party, e.send_mode, e.status, e.created_at
             FROM viewing_negotiation_event e
             LEFT JOIN viewing_negotiation_event newer
               ON newer.negotiation_id = e.negotiation_id
              AND (newer.created_at > e.created_at OR (newer.created_at = e.created_at AND newer.id > e.id))
            WHERE e.negotiation_id IN (${ids.map(() => '?').join(',')})
              AND newer.id IS NULL`,
          ids
        );
        for (const ev of events) lastByNegotiation.set(String(ev.negotiation_id), ev);
      } catch (e) {
        if (!viewingNegotiation.isSchemaMissingError(e)) throw e;
        const [events] = await req.pool.execute(
          `SELECT e.negotiation_id, NULL AS event_type, e.party, NULL AS send_mode, e.status, e.created_at
             FROM viewing_negotiation_event e
             LEFT JOIN viewing_negotiation_event newer
               ON newer.negotiation_id = e.negotiation_id
              AND (newer.created_at > e.created_at OR (newer.created_at = e.created_at AND newer.id > e.id))
            WHERE e.negotiation_id IN (${ids.map(() => '?').join(',')})
              AND newer.id IS NULL`,
          ids
        );
        for (const ev of events) lastByNegotiation.set(String(ev.negotiation_id), ev);
      }
    }
    const data = pageRows.map(r => boardRow(r, lastByNegotiation.get(String(r.id)), setting));
    const nextCursor = rows.length > limit ? encodeCursor(pageRows[pageRows.length - 1]) : null;
    return ok(res, data, { limit, next_cursor: nextCursor, timezone: 'Asia/Hong_Kong' });
  } catch (err) {
    console.error('Public viewing-negotiations error:', err);
    fail(res, 'Failed to load viewing negotiations');
  }
});

// POST /api/public/viewing-negotiation/start
// Body: { unit_id, prospect:{name,phone,email} }
// Staff pressed "Schedule Viewing". Creates the negotiation + first prospect prompt.
router.post('/viewing-negotiation/start', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    let { unit_id, unit_text } = req.body || {};
    const listing_url = req.body ? (req.body.listing_url ?? req.body.listing_link) : null;
    const prospect = (req.body && req.body.prospect) || {};
    if (!unit_id && listing_url == null && !unit_text) return fail(res, 'unit_id, listing_url, or unit_text is required', 400);
    if (!prospect.phone) return fail(res, 'prospect.phone is required', 400);

    let resolvedBy = unit_id ? 'unit_id' : null;
    // Precedence is deliberate: explicit unit_id wins, listing_url is the exact
    // partner-click path, and unit_text remains the fuzzy fallback.
    if (!unit_id && listing_url != null) {
      const [units] = await req.pool.execute(
        `SELECT u.id AS unit_id, u.listing_url
           FROM unit u
           JOIN property p ON p.id = u.property_id
          WHERE p.org_id = ? AND u.active_status = 1`,
        [orgId]
      );
      const listingMatch = findUnitByListingUrl(units, listing_url);
      if (listingMatch.status === 'match') {
        unit_id = listingMatch.unit_id;
        resolvedBy = 'listing_url';
      } else if (!unit_text) {
        const reason = listingMatch.status === 'ambiguous'
          ? 'listing_url_ambiguous'
          : 'listing_url_not_found';
        return ok(res, { available: false, reason,
          message: listingMatch.status === 'ambiguous'
            ? 'This listing link matches more than one unit.'
            : 'This listing link does not match an active unit.' });
      }
    }

    // Text path: Tenafy resolves the unit from the raw phrase and reconfirms /
    // disambiguates in-relay before the day-ask (handles "mongkok 6a", "mk 6a", etc.).
    if (!unit_id && unit_text) {
      const out = await viewingNegotiation.startNegotiationFromText(req.pool, orgId, { unitText: unit_text, prospect });
      return ok(res, { available: true, ...out, resolved_by: 'unit_text' });
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
    return ok(res, { available: true, ...out, resolved_by: resolvedBy || 'unit_id' });
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
    if (neg.state === 'CANCELLED'
      || neg.state === 'NEEDS_STAFF'
      || (viewingNegotiation.TERMINAL_STATES.includes(neg.state)
        && party !== 'tenant')) {
      return ok(res, { closed: true, negotiation_id: negId, state: neg.state,
        needs_staff_reason: neg.needs_staff_reason || null,
        message: 'This viewing request is no longer active — our team will follow up.' });
    }
    const out = await viewingNegotiation.handleReply(req.pool, orgId, neg, party, intent, text, messageId);
    return ok(res, {
      negotiation_id: negId,
      state: out.negotiation ? out.negotiation.state : null,
      needs_staff_reason: out.negotiation ? (out.negotiation.needs_staff_reason || null) : null,
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

// GET /api/public/viewing-negotiation/drafts
//
// Contract with TaneChat: it polls this read-only endpoint, sends each `body`
// verbatim to `to_phone` in that party's own thread, then calls
// POST /viewing-negotiation/:id/draft-sent with the `event_id`. Until draft-sent
// is called the row keeps appearing here. That is intentional at-least-once
// behaviour: draft-sent is idempotent, and a duplicate appearance is safer than a
// message silently never being sent.
//
// This endpoint does not send anything and does not mutate state, so polling it
// is free. Read-only API keys are allowed because this is a GET.
router.get('/viewing-negotiation/drafts', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { limit, maxAgeMinutes, party } = viewingNegotiation.draftQueryOptions(req.query);
    const where = [
      'n.org_id = ?',
      "e.direction = 'out'",
      "e.status = 'draft'",
      // CANCELLED negotiations are excluded because the viewing is not
      // happening; sending a queued "can you confirm Tuesday?" would restart a
      // dead conversation.
      "n.state <> 'CANCELLED'",
      // Drafts are short-lived suggestions. Old rows remain as audit trail, but
      // callers never see them as sendable work after the freshness window.
      `e.created_at >= DATE_SUB(NOW(), INTERVAL ${maxAgeMinutes} MINUTE)`,
      // Draft AGE is not enough on its own. A booking-confirmed draft written on
      // Monday for a Tuesday viewing is only three days old on Thursday, so it would
      // still be returned — and sending "your viewing is confirmed for Tuesday" on
      // Thursday is worse than sending nothing. Suppress any draft whose viewing has
      // already happened. NULL is kept deliberately: a negotiation still resolving a
      // unit or waiting on a day has no proposed time yet and its drafts are valid.
      //
      // Bound in the OPERATOR's clock, not the server's. current_proposed_datetime holds
      // Hong Kong wall clock while MySQL runs UTC, so `> NOW()` kept releasing drafts for
      // about eight hours after the viewing — long enough to send "your viewing is
      // confirmed for 3pm" at ten at night. No grace here on purpose: once the viewing has
      // started there is nothing left to confirm.
      '(n.current_proposed_datetime IS NULL OR n.current_proposed_datetime > ?)',
    ];
    const params = [orgId, orgWallClock(new Date())];
    if (party) {
      where.push('e.party = ?');
      params.push(party);
    }
    // NEEDS_STAFF rows are included: their draft is usually the relay-escalated
    // "our team will follow up shortly" message, which is exactly the one that
    // must not leave the person waiting in silence.
    // CONFIRMED/AUTO_CONFIRMED rows are included: customer_booking_confirmed is
    // created at confirmation time, so filtering terminal states would hide the
    // most important message in the flow.
    // Oldest first is intentional: the draft waiting longest is the most urgent
    // for TaneChat to release.
    const sqlBase =
      ` FROM viewing_negotiation_event e
         JOIN viewing_negotiation n ON n.id = e.negotiation_id
         LEFT JOIN unit u ON u.id = n.unit_id
         LEFT JOIN property p ON p.id = n.property_id
         LEFT JOIN tenant t ON t.id = n.tenant_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at ASC
        LIMIT ${limit}`;
    let rows;
    try {
      [rows] = await req.pool.execute(
        `SELECT e.id AS event_id, e.negotiation_id, n.state AS negotiation_state,
                n.awaiting, e.party, e.to_phone, e.body, e.template_type,
                e.event_type, e.send_mode, e.idempotency_key, e.deadline_at,
                e.created_at, DATE_ADD(e.created_at, INTERVAL ${viewingNegotiation.DRAFT_FRESH_MINUTES} MINUTE) AS expires_at,
                TIMESTAMPDIFF(HOUR, e.created_at, NOW()) AS age_hours,
                n.unit_id, n.prospect_name, n.prospect_phone,
                u.name AS unit_name, p.display_name AS property_name,
                t.phone AS tenant_phone, t.first_name AS tenant_first_name,
                t.last_name AS tenant_last_name, t.company_name AS tenant_company_name
          ${sqlBase}`,
        params
      );
    } catch (e) {
      if (!viewingNegotiation.isSchemaMissingError(e)) throw e;
      [rows] = await req.pool.execute(
        `SELECT e.id AS event_id, e.negotiation_id, n.state AS negotiation_state,
                n.awaiting, e.party, e.to_phone, e.body, e.template_type,
                NULL AS event_type, NULL AS send_mode, NULL AS idempotency_key,
                NULL AS deadline_at, e.created_at,
                DATE_ADD(e.created_at, INTERVAL ${viewingNegotiation.DRAFT_FRESH_MINUTES} MINUTE) AS expires_at,
                TIMESTAMPDIFF(HOUR, e.created_at, NOW()) AS age_hours,
                n.unit_id, n.prospect_name, n.prospect_phone,
                u.name AS unit_name, p.display_name AS property_name,
                t.phone AS tenant_phone, t.first_name AS tenant_first_name,
                t.last_name AS tenant_last_name, t.company_name AS tenant_company_name
          ${sqlBase}`,
        params
      );
    }
    const drafts = rows.map(draftRow);
    return ok(res, {
      drafts,
      count: drafts.length,
      max_age_minutes: maxAgeMinutes,
      fresh_minutes: viewingNegotiation.DRAFT_FRESH_MINUTES,
    });
  } catch (err) {
    console.error('Public viewing-negotiation/drafts error:', err);
    fail(res, 'Failed to load viewing negotiation drafts');
  }
});

// POST /api/public/viewing-negotiation/:id/compose
//
// Renders a fresh outbound suggestion from the current negotiation row only. It
// deliberately does not advance the state machine or touch nudge counters: a
// draft is not a delivered message.
router.post('/viewing-negotiation/:id/compose', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const negId = req.params.id;
    const [[neg]] = await req.pool.execute(
      `SELECT * FROM viewing_negotiation WHERE id = ? AND org_id = ? LIMIT 1`,
      [negId, orgId]
    );
    if (!neg) return fail(res, 'Negotiation not found', 404);

    const candidates = safeParseCandidates(neg.unit_candidates);
    // Current tenant asks do not show the internal response window; send-time
    // side effects arm it from the actual delivery timestamp.
    const step = viewingNegotiation.composeStep({
      state: neg.state,
      awaiting: neg.awaiting,
      hasCandidates: candidates.length > 0,
      hasPendingUnit: Boolean(neg.pending_unit_id),
      policy: {
        require_explicit_confirmation: neg.policy_explicit_confirm == null ? undefined : Boolean(neg.policy_explicit_confirm),
      },
      deadline: null,
    });
    if (!step) return nothingToSend(res, neg.state);

    let ctx = {};
    if (neg.unit_id) {
      ctx = await viewingNegotiation.loadContext(req.pool, neg);
    } else if (neg.pending_unit_id) {
      const [[pending]] = await req.pool.execute(
        `SELECT u.name AS unit_name, p.display_name AS property_name
           FROM unit u JOIN property p ON p.id = u.property_id
          WHERE u.id = ? AND p.org_id = ? LIMIT 1`,
        [neg.pending_unit_id, orgId]
      );
      ctx = pending || {};
    }

    const unitFullName = [ctx.property_name, ctx.unit_name].filter(Boolean).join(' ');
    const tenantName = [ctx.company_name, [ctx.tenant_first_name, ctx.tenant_last_name].filter(Boolean).join(' ')]
      .filter(Boolean)[0] || '';
    const vars = {
      ...viewingNegotiation.viewingNegotiationVars(ctx),
      '%Unit Options%': optionsText(candidates),
      '%Unit Full Name%': unitFullName,
      '%Proposed Time%': viewingNegotiation.formatWhen(neg.current_proposed_datetime),
      '%Tenant Name%': tenantName,
      '%Name - Lease%': tenantName,
      '%Prospect Name%': neg.prospect_name || '',
    };
    if (!requireVars(vars, requiredVarsForTemplate(step.templateType))) {
      return nothingToSend(res, neg.state);
    }

    const eventType = viewingNegotiation.eventTypeForOutbound(step);
    const setting = await viewingNegotiation.getSetting(req.pool, orgId);
    const { mode } = viewingNegotiation.outboundSendDecision(eventType, setting, new Date());
    const body = await viewingNegotiation.renderMessage(req.pool, orgId, step.templateType, vars);
    const [[prior]] = await req.pool.execute(
      `SELECT id, body, created_at
         FROM viewing_negotiation_event
        WHERE negotiation_id = ? AND direction = 'out' AND status = 'draft'
        ORDER BY created_at DESC LIMIT 1`,
      [negId]
    );
    const unchanged = Boolean(prior && prior.body === body);
    if (unchanged && prior && prior.created_at) {
      const created = new Date(prior.created_at);
      if (!Number.isNaN(created.getTime())
          && Date.now() - created.getTime() < viewingNegotiation.DRAFT_FRESH_MINUTES * 60000) {
        const row = await selectDraftForResponse(req.pool, prior.id);
        return ok(res, { ...draftRow(row), unchanged: true });
      }
    }

    let idempotencyKey = null;
    if (eventType) {
      const [[countRow]] = await req.pool.execute(
        `SELECT COUNT(*) AS c FROM viewing_negotiation_event
          WHERE negotiation_id = ? AND event_type = ?`,
        [negId, eventType]
      );
      idempotencyKey = viewingNegotiation.idempotencyKeyFor(
        negId,
        eventType,
        (Number(countRow && countRow.c) || 0) + 1
      );
    }

    const id = newId();
    const toPhone = step.party === 'tenant' ? (ctx.tenant_phone || null) : (neg.prospect_phone || null);
    await req.pool.execute(
      `INSERT INTO viewing_negotiation_event
         (id, negotiation_id, direction, party, to_phone, template_type, body, status, sent_at,
          send_mode, event_type, idempotency_key, deadline_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?)`,
      [id, negId, step.party, toPhone, step.templateType, body, mode, eventType, idempotencyKey,
       step.deadline ? step.deadline.replace('T', ' ') : null]
    );
    const row = await selectDraftForResponse(req.pool, id);
    return ok(res, { ...draftRow(row), unchanged });
  } catch (err) {
    console.error('Public viewing-negotiation/compose error:', err);
    fail(res, 'Failed to compose viewing negotiation draft');
  }
});

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

// POST /api/public/viewing-negotiation/:id/cancel  Body: { reason?: string }
// CONFIRMED / AUTO_CONFIRMED stay refused: a tenant is expecting someone at
// their door and a calendar event exists. Retiring that needs a human to notify
// the tenant, so it remains a staff action — not an oversight.
//
// viewing_negotiation has no cancel-reason column (needs_staff_reason is a
// 32-char hold code; reversal_reason is tenant withdrawal). Accept `reason` so
// the partner can send it, then ignore it rather than invent a migration.
router.post('/viewing-negotiation/:id/cancel', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const negId = req.params.id;
    const reason = req.body ? req.body.reason : undefined;
    if (reason !== undefined) {
      if (typeof reason !== 'string') return fail(res, 'reason must be a string', 400);
      if (reason.length > 500) return fail(res, 'reason must be at most 500 characters', 400);
    }
    const [[neg]] = await req.pool.execute(
      `SELECT * FROM viewing_negotiation WHERE id = ? AND org_id = ? LIMIT 1`,
      [negId, orgId]
    );
    if (!neg) return fail(res, 'Negotiation not found', 404);
    if (neg.state === 'CANCELLED') {
      return ok(res, { cancelled: true, already_cancelled: true });
    }
    if (neg.state === 'CONFIRMED' || neg.state === 'AUTO_CONFIRMED') {
      return res.status(409).json({
        code: 409,
        reason: 'already_confirmed',
        message: 'This viewing is already confirmed. Cancelling it is a staff action so the tenant can be notified.',
      });
    }
    await viewingNegotiation.cancelNegotiation(req.pool, orgId, neg);
    return ok(res, { cancelled: true, already_cancelled: false, state: 'CANCELLED' });
  } catch (err) {
    console.error('Public viewing-negotiation/cancel error:', err);
    fail(res, 'Failed to cancel viewing negotiation');
  }
});

// GET /api/public/viewing-negotiation/active?phone=...
// Routing helper: given an inbound WhatsApp phone, find EVERY open negotiation it
// belongs to (as prospect and/or tenant), so TaneChat can tag the reply — and
// disambiguate when a number is in more than one active negotiation (multi-unit).
// NEEDS_STAFF rows are returned for visibility with routable:false: a human owns
// them, so TaneChat must not post replies into them. `active` therefore means
// "there is at least one routable negotiation", which is intentionally narrower
// than "the returned list is non-empty".
// → { active:bool, negotiations:[{ negotiation_id, party, state, needs_staff_reason, awaiting, routable }, ...] }
//   ordered routable-first, then newest-first with the negotiation actually
//   awaiting that party first within each group.
router.get('/viewing-negotiation/active', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const target = normPhoneDigits(req.query.phone);
    if (!target) return ok(res, { active: false });
    // A CONFIRMED/AUTO_CONFIRMED negotiation whose viewing has not happened yet is
    // still routable FOR THE TENANT: they may withdraw ("sorry, I can't do 3pm after
    // all"), which is the reversal path. Excluding those rows here would make that
    // path unreachable — handleReply accepts a tenant reply on a terminal state, but
    // TaneChat discovers negotiations through THIS endpoint, so it would never send
    // one. Bounded by current_proposed_datetime > NOW() so a viewing that already
    // happened stops matching the tenant's number forever.
    // The reachability floor, in the OPERATOR's clock. A confirmed viewing stays listed for
    // VIEWING_ROUTABLE_GRACE_HOURS past its slot so the occupant can still say "nobody
    // came". Previously this was `> NOW()` — a Hong Kong wall-clock column compared against
    // a UTC server clock, which produced an eight-hour window nobody chose.
    const nowWall = orgWallClock(new Date());
    const graceFloor = viewingNegotiation.addMinutesToWallClock(
      nowWall, -60 * viewingNegotiation.VIEWING_ROUTABLE_GRACE_HOURS);
    let rows;
    try {
      [rows] = await req.pool.execute(
        `SELECT n.id, n.state, n.awaiting, n.needs_staff_reason, n.prospect_phone, n.current_proposed_datetime,
                n.unit_id, u.name AS unit_name, p.display_name AS property_name,
                t.phone AS tenant_phone
           FROM viewing_negotiation n
           LEFT JOIN unit u ON u.id = n.unit_id
           LEFT JOIN property p ON p.id = n.property_id
           LEFT JOIN tenant t ON t.id = n.tenant_id
          WHERE n.state NOT IN ('CONFIRMED','AUTO_CONFIRMED','CANCELLED')
             OR (n.state IN ('CONFIRMED','AUTO_CONFIRMED')
                 AND n.current_proposed_datetime IS NOT NULL
                 AND n.current_proposed_datetime > ?)
          ORDER BY n.updated_at DESC LIMIT 200`,
        [graceFloor]
      );
    } catch (e) {
      if (!viewingNegotiation.isSchemaMissingError(e)) throw e;
      [rows] = await req.pool.execute(
        `SELECT n.id, n.state, n.awaiting, NULL AS needs_staff_reason, n.prospect_phone,
                n.current_proposed_datetime, n.unit_id, u.name AS unit_name,
                p.display_name AS property_name, t.phone AS tenant_phone
           FROM viewing_negotiation n
           LEFT JOIN unit u ON u.id = n.unit_id
           LEFT JOIN property p ON p.id = n.property_id
           LEFT JOIN tenant t ON t.id = n.tenant_id
          WHERE n.state NOT IN ('CONFIRMED','AUTO_CONFIRMED','CANCELLED')
             OR (n.state IN ('CONFIRMED','AUTO_CONFIRMED')
                 AND n.current_proposed_datetime IS NOT NULL
                 AND n.current_proposed_datetime > ?)
          ORDER BY n.updated_at DESC LIMIT 200`,
        [graceFloor]
      );
    }
    const shapedRows = rows.map(r => ({
      ...r,
      prospect_digits: normPhoneDigits(r.prospect_phone),
      tenant_digits: normPhoneDigits(r.tenant_phone),
      // mysql2 parses the DATETIME against the process zone (UTC), which reads the stored
      // Hong Kong wall clock back with the same digits. That is what we want here.
      proposed_wall: viewingNegotiation.dateToWallClock(r.current_proposed_datetime),
      unit_label: [r.property_name, r.unit_name].filter(Boolean).join(' ') || null,
    }));
    return ok(res, viewingNegotiation.activeNegotiationPayload(shapedRows, target, { nowWallClock: nowWall }));
  } catch (err) {
    console.error('Public viewing-negotiation/active error:', err);
    fail(res, 'Failed to look up negotiation');
  }
});

// Company tenants store their name in company_name; individuals in first/last.
const tenantNameSqlPublic = (a) => `CASE WHEN ${a}.type = 1 THEN ${a}.company_name
       ELSE TRIM(CONCAT(COALESCE(${a}.first_name,''), ' ', COALESCE(${a}.last_name,''))) END`;

// ────────────────────────────────────────────────────────────────
// RENEWAL ASK — "is the tenant staying?"
//
// A unit whose tenant has not decided is unsellable: we can only offer it hedged.
// Rather than publish a guessed decision date, we ask the tenant — but only for
// units a prospect actually wants, and only once per decision cycle.
//
// The asymmetry below is the whole design. A reply of "extend" WITHDRAWS the unit
// from customer-facing feeds automatically, because the cost of being wrong is a
// listing we can restore. A reply of "leaving" does NOT mark it firmly available,
// because the cost of being wrong there is promising a customer a home the tenant
// never vacates. Evidence good enough to stop us selling is not good enough to let
// us sell.
// ────────────────────────────────────────────────────────────────

// The lease we would be asking about: the unit's latest lease, still running.
async function currentLeaseForUnit(pool, orgId, unitId) {
  const [[row]] = await pool.execute(
    `SELECT l.id, l.unit_id, l.tenant_id, l.contract_type, l.notice_period_days,
            l.renewal_reply, DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
            u.name AS unit_name, p.display_name AS property_name,
            ${tenantNameSqlPublic('t')} AS tenant_name, t.first_name AS tenant_first_name,
            t.phone AS tenant_phone, t.email AS tenant_email
       FROM leasing l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       LEFT JOIN tenant t ON t.id = l.tenant_id
      WHERE p.org_id = ? AND l.unit_id = ? AND l.deleted_at IS NULL
        AND l.end_date IS NOT NULL
        -- Same liveness guards as the scheduled path. Without them a future or inactive
        -- lease could be queued here and its tenant messaged.
        AND l.status = 1 AND l.lease_state = 'active' AND l.start_date <= ?
      ORDER BY l.end_date DESC, l.id DESC LIMIT 1`,
    [orgId, unitId, orgToday()]
  );
  return row || null;
}

function renewalAskRow(row) {
  return {
    renewal_ask_id: String(row.id),
    unit_id: String(row.unit_id),
    unit_label: [row.property_name, row.unit_name].filter(Boolean).join(' '),
    tenant_name: row.tenant_name || null,
    tenant_phone: row.tenant_phone || null,
    lease_end: row.lease_end_at_ask,
    decision_due_on: row.decision_due_on,
    state: row.state,
    // Tenafy is the only sender of a renewal ask, so the rendered text is deliberately
    // NOT in this payload. Returning it invited a second sender, and two senders is how
    // a tenant gets the same question twice — or, if each assumes the other sent it,
    // never gets asked at all while the ask is counted as spent. Operator decision,
    // 2026-08-19. The wording lives on Chatbot -> Settings and in the audit row.
    dispatch: 'tenafy',
    channel: row.channel || null,
    sent: !!row.sent_at,
    // Handed to a person: three asks went unanswered. It stays on the open list because a late
    // reply must still be attributable, but it no longer holds the conversation — so a second
    // lease for the same tenant CAN be asked, and two rows here may share a phone. At most one
    // row per conversation has `escalated: false`. A partner keying on phone alone needs this,
    // or a legitimate state looks like a broken guarantee.
    escalated: !!row.escalated_at,
  };
}

// POST /api/public/renewal-ask   { unit_id }
// Demand-triggered: call this when a prospect asks about a unit. We decide whether
// an ask is due. Idempotent — an existing live ask for the same cycle is returned
// rather than a second one created, so a retry cannot message a tenant twice.
router.post('/renewal-ask', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const unitId = req.body && req.body.unit_id != null ? String(req.body.unit_id) : null;
    if (!unitId || !/^\d+$/.test(unitId)) return fail(res, 'unit_id is required', 400);

    const settings = await loadSettings(req.pool, orgId);
    if (!Number(settings.renewal_ask_enabled)) {
      return ok(res, { created: false, reason: 'disabled', renewal_ask: null });
    }

    const lease = await currentLeaseForUnit(req.pool, orgId, unitId);
    if (!lease) return fail(res, 'Unit not found', 404);

    const today = orgToday();
    const eligibility = renewalAsk.renewalAskEligibility(lease, {
      today, defaultNoticeDays: settings.renewal_default_notice_days,
      minTenancyDays: settings.renewal_min_tenancy_days,
    });
    if (!eligibility.eligible) {
      return ok(res, { created: false, reason: eligibility.reason, renewal_ask: null });
    }

    const cycle = renewalAsk.renewalAskCycleKey({ ...lease, lease_id: lease.id }, {
      today, defaultNoticeDays: settings.renewal_default_notice_days,
    });

    // Resolved BEFORE the row is written. An ask we cannot deliver would otherwise occupy
    // one of the three slots and then be marked FAILED by the scheduler, spending an ask
    // on a tenant who was never reachable in the first place.
    const channel = renewalAsk.renewalAskChannel(lease);
    if (!channel) {
      return ok(res, { created: false, reason: 'tenant_unreachable', renewal_ask: null });
    }


    // Cooldown. The unique key is (lease_id, lease_end_at_ask, decision_due_on), so an
    // extended lease or a corrected notice period opens a NEW cycle rather than being
    // silenced by the old one.
    const [[existing]] = await req.pool.execute(
      `SELECT id, state, message,
              DATE_FORMAT(lease_end_at_ask, '%Y-%m-%d') AS lease_end_at_ask,
              DATE_FORMAT(decision_due_on, '%Y-%m-%d')  AS decision_due_on
         FROM renewal_ask
        WHERE lease_id = ? AND lease_end_at_ask = ? AND decision_due_on = ?
          AND state <> 'CANCELLED' LIMIT 1`,
      [lease.id, cycle.lease_end_at_ask, cycle.decision_due_on]
    );
    if (existing) {
      return ok(res, { created: false, reason: 'already_asked_this_cycle', renewal_ask: renewalAskRow(existing) });
    }

    const message = renewalAsk.renderRenewalAsk(settings.renewal_ask_phrase,
      renewalAsk.renewalAskVars(lease, { defaultNoticeDays: settings.renewal_default_notice_days, today }));
    // Checked BEFORE the row exists. Inserting first would spend one of the three slots on a
    // message that could never be sent, and the scheduler would then resolve it as FAILED —
    // a tenant never asked, with an ask counted against them. Same rule as the nightly job,
    // which refuses to invent wording the operator has not written.
    if (!message) {
      return ok(res, { created: false, reason: 'no_wording', renewal_ask: null });
    }

    // One open question per conversation, decided INSIDE a lock together with the insert.
    // A tenant renting two units must never be asked about both at once: their reply arrives
    // on one thread referring to neither message, and writing an ambiguous "yes" to the wrong
    // lease invents a renewal decision. Checking outside the lock does not work — two callers
    // both see a clear conversation and both insert.
    const id = newId();
    const claim = await withConversationLock(
      req.pool, orgId, renewalAsk.conversationLockKey({ ...lease, lease_id: lease.id }),
      async (conn) => {
        const conflict = renewalAsk.conflictingOpenAsk(
          await openRenewalAsks(conn, orgId), { ...lease, lease_id: lease.id });
        if (conflict) return { conflict };
        try {
          await conn.execute(
            `INSERT INTO renewal_ask
               (id, org_id, lease_id, unit_id, tenant_id, lease_end_at_ask, decision_due_on,
                state, message, triggered_by, contract_type_at_ask, ask_number, channel, attempts)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, 1, ?, 1)`,
            [id, orgId, lease.id, lease.unit_id, lease.tenant_id || null,
             cycle.lease_end_at_ask, cycle.decision_due_on, message,
             req.body && req.body.triggered_by === 'staff' ? 'staff' : 'inquiry',
             lease.contract_type, channel]
          );
        } catch (e) {
          // Two prospects asked about the same unit at the same moment. The unique key on
          // the cycle is what actually prevents a second message to the tenant; this just
          // turns the loser into the same answer the first caller got.
          if (e && e.code === 'ER_DUP_ENTRY') {
            const [[live]] = await conn.execute(
              `SELECT id, state, channel, sent_at,
                      DATE_FORMAT(lease_end_at_ask, '%Y-%m-%d') AS lease_end_at_ask,
                      DATE_FORMAT(decision_due_on, '%Y-%m-%d')  AS decision_due_on
                 FROM renewal_ask
                WHERE lease_id = ? AND lease_end_at_ask = ? AND decision_due_on = ? LIMIT 1`,
              [lease.id, cycle.lease_end_at_ask, cycle.decision_due_on]);
            return { duplicate: true, live };
          }
          throw e;
        }
        return { inserted: true };
      });

    // Could not get the lock in time. Defer rather than guess — an ask we skip this hour
    // costs a few hours; a tenant asked twice about their own home cannot be undone.
    if (!claim.locked) {
      return ok(res, { created: false, reason: 'conversation_busy', renewal_ask: null, blocked_by: null });
    }
    if (claim.value.conflict) {
      const c = claim.value.conflict;
      return ok(res, {
        created: false, reason: 'conversation_busy', renewal_ask: null,
        blocked_by: {
          renewal_ask_id: String(c.id),
          unit_label: [c.property_name, c.unit_name].filter(Boolean).join(' ') || null,
        },
      });
    }
    if (claim.value.duplicate) {
      const live = claim.value.live;
      return ok(res, {
        created: false, reason: 'already_asked_this_cycle',
        renewal_ask: live ? renewalAskRow({ ...live, unit_id: lease.unit_id,
          unit_name: lease.unit_name, property_name: lease.property_name,
          tenant_name: lease.tenant_name, tenant_phone: lease.tenant_phone }) : null,
      });
    }

    // WE send it, here, before answering. The caller triggers an ask; it never dispatches
    // one. Anything else needs both sides to agree at run time about who transmits, and
    // the failure mode of disagreeing is a tenant asked twice or not at all.
    //
    // Delivered inline rather than left for the nightly job because the row would sit
    // PENDING until then and be resolved as FAILED — spending the slot without a message
    // ever reaching the tenant. And no retry on failure, for the reason set out in
    // renewalAskDispatch: a timed-out send is indistinguishable from a delivered one.
    const sendResult = await deliverRenewalAsk(req.pool, orgId, { channel, lease, message, askId: id });
    const delivered = !!(sendResult && sendResult.ok !== false);
    const sentAt = orgWallClock(new Date());
    if (delivered) {
      await req.pool.execute(
        `UPDATE renewal_ask SET state = 'SENT', sent_at = ? WHERE id = ? AND state = 'PENDING'`,
        [sentAt, id]
      );
    } else {
      await req.pool.execute(
        `UPDATE renewal_ask SET send_error = ? WHERE id = ?`,
        [String((sendResult && sendResult.error) || 'send failed').slice(0, 255), id]
      );
    }

    return ok(res, {
      created: true,
      // The ask exists and has spent its slot either way; `sent` says whether the tenant
      // actually heard from us, which is the part the caller cannot infer.
      reason: delivered ? null : 'send_failed',
      renewal_ask: renewalAskRow({
        id, unit_id: lease.unit_id, unit_name: lease.unit_name, property_name: lease.property_name,
        tenant_name: lease.tenant_name, tenant_phone: lease.tenant_phone,
        lease_end_at_ask: cycle.lease_end_at_ask, decision_due_on: cycle.decision_due_on,
        state: delivered ? 'SENT' : 'PENDING', channel, sent_at: delivered ? sentAt : null,
      }),
    });
  } catch (err) {
    console.error('Public renewal-ask create error:', err);
    fail(res, 'Failed to create renewal ask');
  }
});

// GET /api/public/renewal-asks/pending — OBSERVATIONAL. Reads; never claims.
//
// This was a work queue: it handed each ask out exactly once, stamping claimed_at so no
// two pollers could message the same tenant. That only made sense while the partner did
// the sending — and they never did. Tenafy sends every ask (the nightly job and the
// demand trigger both dispatch inline), so the queue had become a trap: a partner merely
// LOOKING at this list consumed the ask, and because nobody then sent it, the tenant was
// never asked at all while the slot was counted as spent. The list is now a read.
//
// It follows that rows here are only ever asks whose send failed or died mid-flight —
// normally none. The rendered message is deliberately absent from the payload (see
// renewalAskRow) so there is nothing here to send even by accident.

router.get('/renewal-asks/pending', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const settings = await loadSettings(req.pool, orgId);
    // Switching the feature off must stop messages that were queued while it was on.
    // Checking the flag only at creation would let staff disable it and still have
    // TaneChat deliver whatever was already pending.
    if (!Number(settings.renewal_ask_enabled)) {
      return ok(res, { count: 0, renewal_asks: [], reason: 'disabled' });
    }

    const [rows] = await req.pool.execute(
      `SELECT r.id, r.state, r.unit_id, r.channel, r.sent_at,
              DATE_FORMAT(r.lease_end_at_ask, '%Y-%m-%d') AS lease_end_at_ask,
              DATE_FORMAT(r.decision_due_on, '%Y-%m-%d')  AS decision_due_on,
              u.name AS unit_name, p.display_name AS property_name,
              ${tenantNameSqlPublic('t')} AS tenant_name, t.phone AS tenant_phone
         FROM renewal_ask r
         JOIN unit u ON u.id = r.unit_id
         JOIN property p ON p.id = u.property_id
         -- Joined on the tenant we ASKED (r.tenant_id), never the lease's current
         -- tenant: if the tenant changed after the ask was queued, the rendered
         -- message still greets the original person, and sending it to their
         -- replacement would be both wrong and confusing.
         LEFT JOIN tenant t ON t.id = r.tenant_id
        WHERE r.org_id = ? AND r.state = 'PENDING'
        ORDER BY r.decision_due_on ASC
        LIMIT 50`,
      [orgId]
    );
    ok(res, { count: rows.length, dispatch: 'tenafy', renewal_asks: rows.map(r => renewalAskRow(r)) });
  } catch (err) {
    console.error('Public renewal-asks/pending error:', err);
    fail(res, 'Failed to load pending renewal asks');
  }
});

// GET /api/public/renewal-asks/open — sent, not yet answered.
//
// The correlation list. A partner relaying a tenant's reply has to say WHICH ask it answers,
// and after we stopped publishing the rendered message there was nothing left to learn an id
// from: /pending lists only asks we have not sent, which — now that we send inline — is
// almost always empty. So a relay could run, find nothing, and report nothing, silently.
//
// Deliberately NOT a work queue. No message text, no claim, no state change: reading this
// cannot cause or prevent a message. It answers "what is outstanding, and who with", which
// is all a reply needs to be attributed.
router.get('/renewal-asks/open', async (req, res) => {
  try {
    // The SAME query the serialisation rule uses. Two definitions of "outstanding" would
    // drift, and the partner would be told an ask was answerable that we had stopped
    // counting — or the reverse.
    // deliveredOnly: a reply cannot be about a message that never arrived.
    const rows = await openRenewalAsks(req.pool, req.apiKey.orgId, { deliveredOnly: true });
    ok(res, {
      count: rows.length,
      renewal_asks: rows.map(r => ({
        ...renewalAskRow(r),
        ask_number: Number(r.ask_number) || 1,
        sent_at: r.sent_at || null,
        // Present when a vague answer is already on record. Post the real answer against
        // this same id and it supersedes; a definite answer would have closed the cycle and
        // removed the row entirely.
        vague_reply_on_record: Number(r.reply_intent) === 3,
      })),
    });
  } catch (err) {
    console.error('Public renewal-asks/open error:', err);
    fail(res, 'Failed to load open renewal asks');
  }
});

// POST /api/public/renewal-ask/:id/sent — retained, but no longer changes anything.
//
// Kept so an existing caller gets a truthful 200 rather than a 404. It used to flip
// PENDING -> SENT, which was the partner telling us a message went out. Now that Tenafy
// is the only sender, that report can only ever be wrong: it would mark an ask delivered
// on the word of a system that did not deliver it, and the tenant would be recorded as
// asked without ever having been. So this reports the state and writes nothing.
router.post('/renewal-ask/:id/sent', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [[row]] = await req.pool.execute(
      `SELECT id, state, sent_at FROM renewal_ask WHERE id = ? AND org_id = ? LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!row) return fail(res, 'Renewal ask not found', 404);
    ok(res, {
      recorded: false, dispatch: 'tenafy', state: row.state, sent: !!row.sent_at,
      note: 'Tenafy dispatches renewal asks; this endpoint no longer records a send.',
    });
  } catch (err) {
    console.error('Public renewal-ask/sent error:', err);
    fail(res, 'Failed to read renewal ask state');
  }
});

// POST /api/public/renewal-ask/:id/reply  { text } or { intent: extend|leaving|unsure }
//
// Thin wrapper: every rule lives in services/renewalReply so this and the staff route
// cannot drift apart. A staleness check enforced on one path only is not a check.
router.post('/renewal-ask/:id/reply', async (req, res) => {
  try {
    const body = req.body || {};
    // `verified: false` — the relay believes this is an answer but cannot attribute
    // it safely. Records the words, holds the sequence, acts on nothing. Anything
    // other than an explicit false stays on the normal path, so an absent or
    // malformed flag can never silently stop a real answer taking effect.
    const result = await recordRenewalReply(req.pool, req.apiKey.orgId, req.params.id, {
      intent: body.intent, text: body.text, recordedBy: 'partner',
      verified: body.verified === false ? false : true,
    });
    if (result.status !== 200) return fail(res, result.body.message, result.status);
    return ok(res, result.body);
  } catch (err) {
    console.error('Public renewal-ask/reply error:', err);
    fail(res, 'Failed to record renewal reply');
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
    const propertyId = req.query.property_id == null ? null : String(req.query.property_id);
    if (propertyId !== null && (!/^\d+$/.test(propertyId) || propertyId === '0')) return res.status(400).json({ code: 'INVALID_PROPERTY', message: 'Invalid property.' });
    let propertyContext = null;
    if (propertyId !== null) {
      const [ps] = await req.pool.execute('SELECT id, display_name FROM property WHERE id=? AND deleted_at IS NULL', [propertyId]);
      if (!ps.length) return res.status(400).json({ code: 'INVALID_PROPERTY', message: 'Invalid property.' });
      propertyContext = { id:String(ps[0].id), display_name:ps[0].display_name };
    }
    let rows = [];
    let propertyTopics = [];
    try {
      const [r] = await req.pool.execute(
        `SELECT DISTINCT ck.id, ck.kind, ck.category, ck.title, ck.body, ck.tags, ck.updated_at, ck.sort_order, ck.created_at
         FROM chat_knowledge ck
         WHERE ck.status=1 AND ck.visibility='public'
           AND (NOT EXISTS (SELECT 1 FROM chat_knowledge_property s WHERE s.chat_knowledge_id=ck.id)
             OR EXISTS (SELECT 1 FROM chat_knowledge_property s JOIN property p ON p.id=s.property_id AND p.deleted_at IS NULL WHERE s.chat_knowledge_id=ck.id AND s.property_id=?))
         ORDER BY ck.sort_order ASC, ck.created_at ASC`, [propertyId]
      );
      rows = r;
      if (propertyId === null) {
        const [topics] = await req.pool.execute(`SELECT ck.id, ck.kind, ck.category, p.id property_id, p.display_name FROM chat_knowledge ck JOIN chat_knowledge_property s ON s.chat_knowledge_id=ck.id JOIN property p ON p.id=s.property_id AND p.deleted_at IS NULL WHERE ck.status=1 AND ck.visibility='public' ORDER BY ck.id,p.display_name,p.id`);
        const grouped=new Map();
        for(const t of topics){const id=String(t.id);if(!grouped.has(id))grouped.set(id,{id,kind:t.kind,...(t.kind==='faq'?{category:t.category||'other'}:{}),properties:[]});grouped.get(id).properties.push({id:String(t.property_id),display_name:t.display_name});}
        propertyTopics=[...grouped.values()];
      }
    } catch (e) {
      // Table not present on a not-yet-migrated org DB — return an empty rulebook.
      if (e && e.code === 'ER_NO_SUCH_TABLE' && /chat_knowledge_property/.test(e.message || '')) {
        const [legacy] = await req.pool.execute(`SELECT id,kind,title,body,tags,updated_at FROM chat_knowledge WHERE status=1 AND visibility='public' ORDER BY sort_order,created_at`);
        rows = legacy;
      } else if (e && e.code === 'ER_NO_SUCH_TABLE') rows = [];
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
    const version = crypto.createHash('sha256').update(JSON.stringify({ propertyContext, rows, propertyTopics })).digest('hex');
    const updatedAt = maxTs ? new Date(maxTs).toISOString() : null;

    // Conditional GET: 304 when the caller already has this version.
    res.setHeader('ETag', `"${version}"`);
    const inm = req.headers['if-none-match'];
    if (inm && inm.replace(/"/g, '') === version) {
      return res.status(304).end();
    }

    const data={ rules, faqs, prompt_block:promptBlock, version, updated_at:updatedAt, property_context:propertyContext };
    if(propertyId===null)data.property_topics=propertyTopics;
    ok(res, data);
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
// Deprecated: use /vacancies. Kept for TaneChat compatibility.
router.get('/units/available', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || orgToday();
    const propertyId = req.query.propertyId || req.query.property_id || null;

    // DEPRECATED in favour of GET /vacancies, which also reports units coming free
    // and carries renewal intent. This handler deliberately keeps its ORIGINAL query,
    // response fields and `date` parameter: its whole remaining job is to not break
    // callers while they migrate, and `?date=` is documented usage. The only change is
    // the gap filter below.
    res.set('Deprecation', 'true');

    let whereClause = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1';
    const params = [orgId];

    if (propertyId) {
      whereClause += ' AND p.id = ?';
      params.push(propertyId);
    }

    // The bug this endpoint shipped with: "no lease active on `date`" also matches a
    // unit that is already re-let. Unit "6A Test" was reported as available while a
    // tenant moved in three days later. Exclude anything whose next tenancy starts
    // within the inquiry minimum gap of `date` — it is vacant on paper and taken
    // in practice.
    const settings = await loadSettings(req.pool, orgId);
    const inquiryWindows = resolveAvailabilityWindows(settings, 'inquiry');

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
         AND NOT EXISTS (
           SELECT 1 FROM leasing nl
            WHERE nl.unit_id = u.id AND nl.deleted_at IS NULL
              AND nl.start_date > ?
              AND nl.start_date <= DATE_ADD(?, INTERVAL ${inquiryWindows.min_gap_days} DAY)
         )
       ORDER BY p.display_name, u.name`,
      [date, date, ...params, date, date]
    );

    ok(res, units, { date, deprecated: true, replacement: '/vacancies' });
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
//   available_between_start/end (ISO dates)   — window search; when present, takes precedence over move_in_date/move_out_date for filtering
//     In window mode `district` stops being a filter and becomes a PREFERENCE: units
//     outside it still come back, in `alternatives_outside_area`, so the caller can ask
//     "would you consider elsewhere?" instead of reporting nothing. `city` remains a hard
//     filter — a caller that names a city is stating a constraint, not a preference, and
//     an alternative across the harbour is not an alternative.
//   bedrooms, bathrooms                       — exact match on unit.beds/baths
//   min_price, max_price                      — matched against asking_rent.amount; both bounds keep unpriced units
//   property_id                               — filter to property
//   city (csv)                                — region match, e.g. "Kowloon" or "Hong Kong Island" (case-insensitive)
//   district (csv)                            — neighbourhood match, e.g. "Causeway Bay,Wan Chai" (case-insensitive)
//   amenities (csv)                           — names like "parking,gym"; unit must have ALL
//   sort_by                                   — vacancy_gap (default), price_asc, price_desc
//   limit                                     — default 10, max 100
router.get('/units/search', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const moveIn = req.query.move_in_date || orgToday();
    const moveOut = req.query.move_out_date || null;
    const hasWindowStart = req.query.available_between_start !== undefined;
    const hasWindowEnd = req.query.available_between_end !== undefined;
    if (hasWindowStart !== hasWindowEnd) {
      return res.status(400).json({ code: 400, message: 'available_between_start and available_between_end must be supplied together' });
    }
    const windowStart = hasWindowStart ? String(req.query.available_between_start) : null;
    const windowEnd = hasWindowEnd ? String(req.query.available_between_end) : null;
    if (hasWindowStart && !isStrictYmd(windowStart)) {
      return res.status(400).json({ code: 400, message: 'available_between_start must be in YYYY-MM-DD format' });
    }
    if (hasWindowEnd && !isStrictYmd(windowEnd)) {
      return res.status(400).json({ code: 400, message: 'available_between_end must be in YYYY-MM-DD format' });
    }
    if (hasWindowStart && hasWindowEnd && windowEnd < windowStart) {
      return res.status(400).json({ code: 400, message: 'available_between_end must be on or after available_between_start' });
    }
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
    const settings = await loadSettings(req.pool, orgId);
    const searchResult = await searchUnits(req.pool, {
      orgId,
      moveIn,
      moveOut,
      windowStart,
      windowEnd,
      gapBands: resolveGapBands(settings, 'search'),
      bedrooms: (bedrooms !== null && !Number.isNaN(bedrooms)) ? bedrooms : null,
      bathrooms: (bathrooms !== null && !Number.isNaN(bathrooms)) ? bathrooms : null,
      minPrice: (minPrice !== null && !Number.isNaN(minPrice)) ? minPrice : null,
      maxPrice: (maxPrice !== null && !Number.isNaN(maxPrice)) ? maxPrice : null,
      budgetMarginPct: 0,
      budget: (budget !== null && !Number.isNaN(budget)) ? budget : null,
      propertyId,
      cityNames,
      districtNames,
      preferredDistricts: districtNames,
      amenityNames,
      sortBy,
      limit,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    const { results, total, alternativesOutsideArea } = searchResult;

    const meta = {
      total_matches: total,
      move_in_date: moveIn,
      move_out_date: moveOut,
      lease_duration_days: moveOut
        ? Math.max(0, Math.round((new Date(moveOut) - new Date(moveIn)) / 86400000))
        : null,
      budget: budget,
      sort_by: sortBy,
    };
    if (windowStart && windowEnd) {
      meta.available_between_start = windowStart;
      meta.available_between_end = windowEnd;
      // ALWAYS present in window mode, empty array included. An absent key and an
      // empty one are indistinguishable to a consumer — "no alternatives outside
      // the area" would look identical to "this deployment predates the feature",
      // and the caller cannot tell whether silence is an answer.
      return ok(res, results, meta, { alternatives_outside_area: alternativesOutsideArea || [] });
    }
    ok(res, results, meta);
  } catch (error) {
    console.error('Public units search error:', error);
    fail(res, 'Failed to search units');
  }
});

// POST /api/public/units/resolve
// Read-only unit lookup for qualification flows. Mirrors viewing negotiation's
// unit_id -> listing_url -> unit_text precedence without starting a negotiation.
router.post('/units/resolve', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const body = req.body || {};
    const badField = badResolveField(body);
    if (badField) return fail(res, `${badField} must be a string`, 400);

    const unitId = body.unit_id || null;
    const listingUrl = body.listing_url ?? body.listing_link ?? null;
    const unitText = typeof body.unit_text === 'string' ? body.unit_text.trim() : '';
    if (!unitId && listingUrl == null && !unitText) {
      return fail(res, 'unit_id, listing_url, or unit_text is required', 400);
    }
    if (unitText.length > 500) return fail(res, 'unit_text must be 500 characters or fewer', 400);

    const units = await loadUnitsWithMarketable(req.pool, orgId);
    const byId = new Map(units.map(u => [String(u.id), u]));

    // An unknown unit_id does NOT fall through to the other paths, though an
    // unknown listing_url does. The asymmetry is deliberate: a listing URL comes
    // from an ad click and goes stale on its own, whereas a unit_id is one WE
    // issued, so a miss means the caller has a bug or is probing another tenant.
    // Quietly fuzzy-matching their way to a different unit would hide both.
    if (unitId) {
      const unit = byId.get(String(unitId));
      return ok(res, {
        // 'none' rather than a 404, so a typo and another org's real unit are
        // indistinguishable from outside.
        status: unit ? 'confident' : 'none',
        resolved_by: 'unit_id',
        match: unit ? publicUnitOut(unit) : null,
        candidates: [],
        unmatched: [],
      });
    }

    if (listingUrl != null) {
      const [listingRows] = await req.pool.execute(
        `SELECT u.id AS unit_id, u.listing_url
           FROM unit u
           JOIN property p ON p.id = u.property_id
          WHERE p.org_id = ? AND u.active_status = 1`,
        [orgId]
      );
      const listingMatch = findUnitByListingUrl(listingRows, listingUrl);
      if (listingMatch.status === 'match') {
        const unit = byId.get(String(listingMatch.unit_id));
        if (unit) {
          return ok(res, {
            status: 'confident',
            resolved_by: 'listing_url',
            match: publicUnitOut(unit),
            candidates: [],
            unmatched: [],
          });
        }
      } else if (listingMatch.status === 'ambiguous') {
        const target = normalizeListingUrl(listingUrl);
        const candidates = (listingRows || [])
          .filter(row => normalizeListingUrl(row.listing_url) === target)
          .map(row => byId.get(String(row.unit_id)))
          .filter(Boolean)
          .map(publicUnitOut);
        return ok(res, {
          status: 'ambiguous',
          resolved_by: 'listing_url',
          match: null,
          candidates,
          unmatched: [],
        });
      }
      if (!unitText) {
        return ok(res, {
          status: 'none',
          resolved_by: 'listing_url',
          match: null,
          candidates: [],
          unmatched: [],
        });
      }
    }

    const out = await resolveUnit(req.pool, orgId, unitText);
    return ok(res, {
      status: out.status,
      resolved_by: 'unit_text',
      match: out.status === 'confident' ? out.match : null,
      candidates: out.candidates || [],
      candidate_count: out.candidate_count || 0,
      unmatched: out.unmatched || [],
      query: out.query,
    });
  } catch (err) {
    console.error('Public units/resolve error:', err);
    fail(res, 'Failed to resolve unit');
  }
});

// GET /api/public/properties?date=YYYY-MM-DD&has_available_units=true
// All active properties with total/available unit counts + amenity names.
router.get('/properties', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || orgToday();
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
                  AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)
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
         AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)
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
    const today = orgToday();
    let availableFrom = today;
    if (latestLease && latestLease.end_date) {
      const endStr = dbDate(latestLease.end_date);
      if (endStr) {
        currentMoveOut = endStr;
        const next = new Date(endStr);
        next.setDate(next.getDate() + 1);
        const nextStr = next.toISOString().split('T')[0];
        if (nextStr > availableFrom) availableFrom = nextStr;
      }
    }
    const daysToAvailable = unitDetailDaysToAvailable(currentMoveOut, today);

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
        asking_rent: askingRentPublicShape(unit.rent_price_min, unit.rent_price_max, daysToAvailable),
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
    const today = orgToday();
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
    } else if (digits.length >= 8) {
      const suffix = renewalAsk.conversationKey(digits);
      [tenants] = await req.pool.execute(
        `SELECT id, first_name, last_name, company_name, type
           FROM tenant
          WHERE org_id = ? AND category = 1
            AND phone IS NOT NULL AND phone <> ''
            AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 8) = ?`,
        [orgId, suffix]
      );
    } else {
      return fail(res, 'Provide a "phone" (at least 8 digits) or "email" query param.', 400);
    }

    if (tenants.length === 0) {
      return ok(res, { matched: false, classification: 'unknown', count: 0, tenants: [], active_properties: [], property_resolution: 'none' });
    }

    const today = orgToday();
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
    const activeProperties = new Map();
    for (const t of tenants) {
      const [leases] = await req.pool.execute(
        `SELECT l.lease_no, l.start_date, l.end_date,
                u.name AS unit_name, p.id AS property_id, p.display_name AS property_name
           FROM leasing l
           LEFT JOIN unit u ON l.unit_id = u.id
           LEFT JOIN property p ON u.property_id = p.id AND p.deleted_at IS NULL
          WHERE l.tenant_id = ? AND l.deleted_at IS NULL
          ORDER BY l.start_date DESC`,
        [t.id]
      );
      let best = null, bestStatus = null;
      for (const l of leases) {
        const st = leaseStatus(l);
        if (st === 'active' && l.property_id != null) {
          activeProperties.set(String(l.property_id), { id: String(l.property_id), display_name: l.property_name });
        }
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
    const active_properties = [...activeProperties.values()];
    const property_resolution = active_properties.length === 1 ? 'unique' : active_properties.length > 1 ? 'ambiguous' : 'none';
    ok(res, { matched: true, classification, count: out.length, tenants: out, active_properties, property_resolution });
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
              DATEDIFF(l.end_date, ${orgTodaySql()}) AS days_until_expiry
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL
         AND DATEDIFF(l.end_date, ${orgTodaySql()}) BETWEEN 0 AND ?
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
      whereClause += ` AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)`;
    } else if (status === 'upcoming') {
      whereClause += ` AND l.start_date > ${orgTodaySql()}`;
    } else if (status === 'inactive') {
      whereClause += ` AND l.end_date < ${orgTodaySql()}`;
    }
    // 'terminated' is handled by deleted_at, which is always excluded above

    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email, t.phone AS tenant_phone,
              CASE
                WHEN l.start_date > ${orgTodaySql()} THEN 'upcoming'
                WHEN l.end_date < ${orgTodaySql()} THEN 'inactive'
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
                WHEN l.start_date > ${orgTodaySql()} THEN 'upcoming'
                WHEN l.end_date < ${orgTodaySql()} THEN 'inactive'
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

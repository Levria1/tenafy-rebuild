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
const { createViewingEvent, updateViewingEvent, getFreeBusy, deleteViewingEvent } = require('./googleCalendar');
const { sendWhatsApp, loadWhatsAppTemplate } = require('./whatsappService');
const { sendViewingConfirmation } = require('./viewingNotify');
const { loadTemplate, substituteVariables } = require('./emailService');
const { KIND_ACTION, KIND_MANAGE } = require('../middleware/viewingTokenAuth');
const {
  DEFAULT_SETTING, combineDateTime, minutesOf, withinWindow, viewingWindow, marketabilityDecision,
  RESUMABLE_HOLD_REASONS, nextStep, buildRouting,
  reminderTarget, activeNegotiationPayload,
  STATE_AUTO_CONFIRMED, STATE_TENANT_REVERSED, STATE_RESCHEDULE_AFTER_COMMIT,
  TERMINAL_STATES, CLOSED_STATES,
  resolvePolicy, optOutDeadline, noticeIsActionable, autoConfirmDecision, nudgeDecision,
  reversalClassification,
  sendModeFor, idempotencyKeyFor, withinQuietHours,
  draftQueryOptions,
} = require('./viewingNegotiationLogic');
const { findActiveLeaseForUnit } = require('./viewingBooking');
const { resolveUnit, optionsText } = require('./unitResolver');
const {
  viewingSlotOverlaps,
  negotiationConflictOverlaps,
  decideCalendarHoldSync,
} = require('./viewingCalendarHoldLogic');

function safeParseCandidates(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Turn a resolver outcome into the row updates + first outbound for the unit
// resolution phase. Shared by startNegotiationFromText (new row) and handleReply
// (a 're-resolve' on a fresh name). Returns { set, outbounds }.
async function computeResolutionPlan(pool, orgId, text, prospectPhone) {
  const r = await resolveUnit(pool, orgId, text);
  const set = { pending_unit_text: text ? String(text).slice(0, 255) : null };
  const outbounds = [];
  if (r.status === 'confident') {
    set.pending_unit_id = r.match.unit_id;
    set.unit_candidates = null;
    set.state = 'CONFIRM_UNIT'; set.awaiting = 'prospect';
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Confirm-Unit',
      vars: { '%Unit Full Name%': r.match.label, '%Property Name%': r.match.property_name, '%Unit Name%': r.match.unit_name } });
  } else if (r.status === 'multi_unit') {
    // Prospect named more than one unit. We don't auto-arrange multi-unit
    // viewings yet — park it for a human and switch this conversation to manual.
    set.pending_unit_id = null;
    set.unit_candidates = JSON.stringify(r.candidates.map(c => ({ unit_id: c.unit_id, label: c.label })));
    set.state = 'NEEDS_STAFF'; set.awaiting = 'staff'; set.needs_staff_reason = 'multi_unit';
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Hold-MultiUnit', vars: {} });
    await notifyStaff(pool, orgId, 'Viewing request needs review',
      `A prospect asked to view more than one unit ("${String(text || '').slice(0, 120)}"). Arrange this one manually.`);
  } else if (r.status === 'ambiguous' || r.status === 'property_only') {
    set.pending_unit_id = null;
    set.unit_candidates = JSON.stringify(r.candidates.map(c => ({ unit_id: c.unit_id, label: c.label })));
    set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect';
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Choose-Unit',
      vars: { '%Unit Options%': optionsText(r.candidates), '%Property Name%': (r.candidates[0] && r.candidates[0].property_name) || '' } });
  } else { // none
    set.pending_unit_id = null;
    set.unit_candidates = null;
    set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect';
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Unit-NotFound', vars: {} });
  }
  return { set, outbounds };
}

// Today as 'YYYY-MM-DD' in the server's local wall-clock (prod is UTC). Isolated
// so the pure viewingWindow() stays deterministic/testable (takes `today` as arg).
function todayYmd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
function tenantDisplayName(ctx) {
  if (!ctx) return '';
  return ctx.company_name || [ctx.tenant_first_name, ctx.tenant_last_name].filter(Boolean).join(' ') || '';
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
      read_back: row.read_back == null ? 1 : Number(row.read_back),
      viewing_days: row.viewing_days || DEFAULT_SETTING.viewing_days,
      viewing_start: row.viewing_start || DEFAULT_SETTING.viewing_start,
      viewing_end: row.viewing_end || DEFAULT_SETTING.viewing_end,
      lead_days_nr: row.lead_days_nr == null ? DEFAULT_SETTING.lead_days_nr : Number(row.lead_days_nr),
      lead_days_other: row.lead_days_other == null ? DEFAULT_SETTING.lead_days_other : Number(row.lead_days_other),
      customer_nudge_1_hours: row.customer_nudge_1_hours == null ? DEFAULT_SETTING.customer_nudge_1_hours : Number(row.customer_nudge_1_hours),
      customer_nudge_2_hours: row.customer_nudge_2_hours == null ? DEFAULT_SETTING.customer_nudge_2_hours : Number(row.customer_nudge_2_hours),
      customer_nudge_cap: row.customer_nudge_cap == null ? DEFAULT_SETTING.customer_nudge_cap : Number(row.customer_nudge_cap),
      customer_timeout_hours: row.customer_timeout_hours == null ? DEFAULT_SETTING.customer_timeout_hours : Number(row.customer_timeout_hours),
      tenant_opt_out_hours: row.tenant_opt_out_hours == null ? DEFAULT_SETTING.tenant_opt_out_hours : Number(row.tenant_opt_out_hours),
      tenant_explicit_timeout_hours: row.tenant_explicit_timeout_hours == null ? DEFAULT_SETTING.tenant_explicit_timeout_hours : Number(row.tenant_explicit_timeout_hours),
      tenant_nudge_cap: row.tenant_nudge_cap == null ? DEFAULT_SETTING.tenant_nudge_cap : Number(row.tenant_nudge_cap),
      auto_send_nudges: row.auto_send_nudges == null ? DEFAULT_SETTING.auto_send_nudges : Number(row.auto_send_nudges),
      respect_quiet_hours: row.respect_quiet_hours == null ? DEFAULT_SETTING.respect_quiet_hours : Number(row.respect_quiet_hours),
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

// Is ANYONE rostered to show this property, on any weekday?
async function propertyHasRosteredStaff(pool, propertyId) {
  try {
    const [[row]] = await pool.execute(
      `SELECT 1 FROM viewing_staff_roster
        WHERE property_id = ? AND active = 1 LIMIT 1`,
      [propertyId]
    );
    return !!row;
  } catch {
    return false; // table not migrated
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
async function checkStaffFree(pool, { employeeId, unitId, whenIso, buffer, calendarId, excludeNegotiationId }) {
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
    if (viewingSlotOverlaps({
      proposedStart: start,
      proposedEnd: end,
      existingDatetime: b.proposed_datetime,
      durationMinutes: b.duration_minutes,
      bufferMin,
    })) return { free: false };
  }
  try {
    // Only emit the self-exclusion clause when we actually have an id. `id <> NULL`
    // evaluates to NULL in SQL, which would make the WHERE false for EVERY row and
    // silently delete this entire conflict check — a caller that forgot the argument
    // would look like "no conflicts" rather than an error. checkStaffFree is exported,
    // so that caller may not be in this file. The JS-level guard below excludes self
    // regardless; this just keeps the query honest.
    const excludeSql = excludeNegotiationId == null ? '' : 'AND id <> ? ';
    const [negRows] = await pool.execute(
      `SELECT id, current_proposed_datetime
         FROM viewing_negotiation
        WHERE state NOT IN (${sqlList(CLOSED_STATES)})
          AND current_proposed_datetime IS NOT NULL
          AND (staff_employee_id = ? OR unit_id = ?)
          ${excludeSql}
          AND current_proposed_datetime >= ? AND current_proposed_datetime <= ?`,
      excludeNegotiationId == null
        ? [employeeId, unitId, fetchStart, padEnd]
        : [employeeId, unitId, excludeNegotiationId, fetchStart, padEnd]
    );
    for (const row of negRows) {
      if (negotiationConflictOverlaps(row, excludeNegotiationId, {
        proposedStart: start,
        proposedEnd: end,
        bufferMin,
      })) return { free: false };
    }
  } catch (e) {
    if (!isSchemaMissingError(e)) throw e;
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

function hasCalendarHoldColumns(neg) {
  return neg && Object.prototype.hasOwnProperty.call(neg, 'gcal_hold_event_id');
}

function staffDisplayName(staff) {
  return [staff && staff.first_name, staff && staff.last_name].filter(Boolean).join(' ')
      || (staff && staff.email) || 'Staff';
}

function holdDatetimeSql(whenIso) {
  const s = dateToWallClock(whenIso);
  return s ? s.replace('T', ' ') : null;
}

function holdEventPayload(neg, ctx, whenIso, staff) {
  return {
    booking: {
      proposed_datetime: whenIso,
      duration_minutes: 30,
      viewer_name: neg.prospect_name || 'Prospect',
      viewer_email: neg.prospect_email || '',
      viewer_phone: neg.prospect_phone || null,
      viewer_message: null,
    },
    unit: { name: ctx.unit_name || 'Unit' },
    property: {
      name: ctx.property_name || 'Property',
      street_address: ctx.street_address,
      city: ctx.city,
      state: ctx.state,
    },
    employee: { name: staffDisplayName(staff), email: staff.email },
  };
}

async function syncCalendarHold(pool, orgId, neg, { whenIso, staff } = {}) {
  if (!hasCalendarHoldColumns(neg)) return;
  const calendarId = staff && staff.google_calendar_id ? String(staff.google_calendar_id).trim() : '';
  if (!staff || !whenIso || !calendarId) return;

  const action = decideCalendarHoldSync({
    existingEventId: neg.gcal_hold_event_id,
    existingCalendarId: neg.gcal_hold_calendar_id,
    existingDatetime: neg.gcal_hold_datetime,
  }, { calendarId, whenIso });
  if (action === 'skip' || action === 'noop') return;

  const ctx = await loadContext(pool, neg);
  const payload = holdEventPayload(neg, ctx, whenIso, staff);
  const holdSql = holdDatetimeSql(whenIso);
  if (!holdSql) return;

  try {
    if (action === 'patch') {
      const ok = await updateViewingEvent({
        calendarId,
        gcalEventId: neg.gcal_hold_event_id,
        ...payload,
      }, { tentative: true });
      if (!ok) return;
      await pool.execute(
        `UPDATE viewing_negotiation
            SET gcal_hold_datetime = ?, updated_at = updated_at
          WHERE id = ?`,
        [holdSql, neg.id]
      );
      return;
    }

    if (action === 'move' && neg.gcal_hold_event_id && neg.gcal_hold_calendar_id) {
      deleteViewingEvent({
        calendarId: neg.gcal_hold_calendar_id,
        gcalEventId: neg.gcal_hold_event_id,
      }).catch(e => console.error('[viewingNegotiation] gcal hold delete failed:', e.message));
    }

    const eventId = await createViewingEvent({ calendarId, ...payload }, { tentative: true });
    if (!eventId) return;
    await pool.execute(
      `UPDATE viewing_negotiation
          SET gcal_hold_event_id = ?, gcal_hold_datetime = ?, gcal_hold_calendar_id = ?,
              updated_at = updated_at
        WHERE id = ?`,
      [eventId, holdSql, calendarId, neg.id]
    );
  } catch (e) {
    if (!isSchemaMissingError(e)) throw e;
  }
}

async function clearCalendarHold(pool, orgId, neg) {
  if (!hasCalendarHoldColumns(neg)) return;
  const eventId = neg.gcal_hold_event_id;
  const calendarId = neg.gcal_hold_calendar_id;
  if (eventId && calendarId) {
    deleteViewingEvent({ calendarId, gcalEventId: eventId })
      .catch(e => console.error('[viewingNegotiation] gcal hold delete failed:', e.message));
  }
  if (!eventId && !calendarId && !neg.gcal_hold_datetime) return;
  try {
    await pool.execute(
      `UPDATE viewing_negotiation
          SET gcal_hold_event_id = NULL, gcal_hold_datetime = NULL, gcal_hold_calendar_id = NULL,
              updated_at = updated_at
        WHERE id = ?`,
      [neg.id]
    );
  } catch (e) {
    if (!isSchemaMissingError(e)) throw e;
  }
}

// ── outbound rendering + dispatch ─────────────────────────────────────────────
const FALLBACKS = {
  'Viewing-Prospect-Day-Ask': `Hi! We'd love to arrange a viewing of %Unit Name% at %Property Name%. Which day and time would suit you? (Viewings run Mon–Sat, 11am–7pm.)`,
  'Viewing-Slot-Taken': `Sorry, %Proposed Time% isn't available. Could you suggest another day and time?`,
  'Viewing-Checking': `Thanks! Let me check on %Proposed Time% for you and confirm the viewing.`,
  'Viewing-Tenant-Ask': `Hi, a prospective viewer would like to see %Unit Name% at %Proposed Time%. Would that be okay?`,
  // The deadline substitution is load-bearing: if %Opt Out Deadline% renders
  // empty, the message stops being an informed opt-out and the auto-confirm that
  // follows is no longer consented to. chooseTenantNoticeTemplate falls back to
  // the explicit-YES wording whenever the deadline is missing.
  'Viewing-Tenant-OptOut': `Hi %Tenant Name%, %Prospect Name% would like to view %Unit Name% on %Proposed Time%. Unless you reply no or ask to reschedule by %Opt Out Deadline%, we'll confirm this viewing. If the time doesn't work, please reply here.`,
  'Viewing-Tenant-Explicit': `Hi %Tenant Name%, %Prospect Name% would like to view %Unit Name% on %Proposed Time%. Please reply yes to confirm this works, or send another time that would be better.`,
  'Viewing-Tenant-Alt-Ask': `Got it, no problem. May I ask which day and time would work best for you?`,
  'Viewing-Relay-Prospect': `Sorry, %Old Time% doesn't work for the occupant. Would %Proposed Time% work for you instead?`,
  'Viewing-Reversal-Prospect': `Sorry, the occupant can no longer make the confirmed viewing time. Apologies for the change — our team will be in touch with alternatives shortly.`,
  'Viewing-Reschedule-Prospect': `The occupant has proposed %Proposed Time% instead. Would that work for you?`,
  'Viewing-Outside-Hours': `Sorry, %Proposed Time% is outside our viewing hours. Could you suggest another day and time? (Viewings run Mon–Sat, 11am–7pm.)`,
  'Viewing-Confirm-Time': `Just to confirm — a viewing of %Unit Name% at %Property Name% on %Proposed Time%? Reply YES to confirm, or send a different day and time.`,
  'Viewing-Relay-Confirmed': `Great news — your viewing of %Unit Name% is confirmed for %Proposed Time%. See you then!`,
  'Viewing-Relay-Escalated': `Thanks for your patience — our team will follow up with you shortly to finalise the viewing.`,
  // Deliberately names no unit. The reminder is the ONE outbound that can fire while
  // the unit is still unresolved (a negotiation parked in RESOLVE_UNIT is exactly the
  // kind that goes quiet), so %Unit Name%/%Property Name% may both be empty and a
  // template built around them would send "your viewing of  at ". The WhatsApp thread
  // already names the unit above this message. If an org customises this template,
  // keep it unit-agnostic for the same reason.
  'Viewing-Relay-Reminder': `Just checking in on this viewing request. Reply when you're ready, and we'll keep things moving.`,
  'Viewing-Hold-OffWindow': `Thanks for your interest in %Unit Name%! Let me check with our team and get back to you about arranging a viewing.`,
  'Viewing-Confirm-Unit': `Just to confirm — you'd like to view %Unit Full Name%? Reply YES, or tell me the correct unit.`,
  'Viewing-Choose-Unit': `Which unit would you like to view?\n%Unit Options%\n\nReply with the number or the unit name.`,
  'Viewing-Unit-NotFound': `Sorry, I couldn't find that unit. Which property and unit would you like to view?`,
  'Viewing-Hold-MultiUnit': `Thanks! It looks like you'd like to view more than one unit — I'll have a colleague help arrange that. Someone from our team will follow up with you shortly.`,
};

const EVENT_TYPES = [
  'customer_confirm_request',
  'customer_nudge',
  'tenant_nudge',
  'tenant_opt_out_notice',
  'tenant_explicit_confirm_request',
  'customer_booking_confirmed',
  'customer_reschedule_request',
  'customer_reversal_notice',
  'staff_alert',
];

const EVENT_TYPE_BY_TEMPLATE = {
  'Viewing-Prospect-Day-Ask': 'customer_confirm_request',
  'Viewing-Confirm-Time': 'customer_confirm_request',
  'Viewing-Tenant-OptOut': 'tenant_opt_out_notice',
  'Viewing-Tenant-Explicit': 'tenant_explicit_confirm_request',
  'Viewing-Tenant-Ask': 'tenant_explicit_confirm_request',
  'Viewing-Relay-Confirmed': 'customer_booking_confirmed',
  'Viewing-Relay-Prospect': 'customer_reschedule_request',
  'Viewing-Relay-Escalated': 'customer_reschedule_request',
  'Viewing-Reversal-Prospect': 'customer_reversal_notice',
  'Viewing-Reschedule-Prospect': 'customer_reschedule_request',
};

function eventTypeForOutbound(ob) {
  if (Object.prototype.hasOwnProperty.call(ob || {}, 'eventType')) return ob.eventType || null;
  if (ob && ob.templateType === 'Viewing-Relay-Reminder') {
    return ob.party === 'tenant' ? 'tenant_nudge' : 'customer_nudge';
  }
  return EVENT_TYPE_BY_TEMPLATE[ob && ob.templateType] || null;
}

function outboundSendDecision(eventType, setting, now = new Date()) {
  setting = { ...DEFAULT_SETTING, ...(setting || {}) };
  const mode = sendModeFor(eventType, setting);
  let shouldSend = mode === 'auto' || setting.relay_mode === 'auto';
  let quietSuppressed = false;
  if (mode === 'auto' && setting.respect_quiet_hours && withinQuietHours(dateToWallClock(now), setting)) {
    // A nudge is never urgent enough to wake someone; the next hourly cron tick
    // will pick it up when the org's viewing window is open again.
    shouldSend = false;
    quietSuppressed = true;
  }
  return { mode, shouldSend, quietSuppressed };
}

function chooseTenantNoticeTemplate(policy, deadline) {
  if (policy && policy.require_explicit_confirmation) {
    return { templateType: 'Viewing-Tenant-Explicit', eventType: 'tenant_explicit_confirm_request', deadline: null };
  }
  if (!deadline) {
    return { templateType: 'Viewing-Tenant-Explicit', eventType: 'tenant_explicit_confirm_request', deadline: null };
  }
  return { templateType: 'Viewing-Tenant-OptOut', eventType: 'tenant_opt_out_notice', deadline };
}

function isClosedState(state) {
  return CLOSED_STATES.includes(state);
}

function isNudgeCandidate(row) {
  return row && !isClosedState(row.state) && ['prospect', 'tenant'].includes(row.awaiting);
}

function isStaleCandidate(row) {
  return row && !isClosedState(row.state);
}

function boardNextDeadline(row, setting, now = new Date()) {
  const autoDecision = autoConfirmDecision(row, now);
  if (autoDecision.action === 'auto_confirm' || autoDecision.action === 'wait') {
    return {
      kind: 'opt_out_expiry',
      due_at: dateToWallClock(row && row.opt_out_deadline_at),
      overdue: autoDecision.action === 'auto_confirm',
    };
  }
  const nudge = nudgeDecision(row, setting, now);
  if (nudge.action === 'nudge') {
    return { kind: `${nudge.party}_nudge`, due_at: dateToWallClock(now), overdue: true };
  }
  if (nudge.action === 'escalate') {
    return { kind: nudge.party === 'prospect' ? 'customer_timeout' : 'tenant_timeout', due_at: dateToWallClock(now), overdue: true };
  }
  return { kind: null, due_at: null, overdue: false };
}

function sqlList(values) {
  return values.map(v => `'${String(v).replace(/'/g, "''")}'`).join(', ');
}

const V2_NEGOTIATION_COLUMNS = new Set([
  'customer_asked_at', 'tenant_notified_at', 'opt_out_deadline_at', 'auto_confirmed_at',
  'customer_nudge_count', 'tenant_nudge_count', 'last_nudge_at',
  'policy_opt_out_hours', 'policy_explicit_confirm', 'policy_source', 'reversal_reason',
]);

async function renderMessage(pool, orgId, templateType, vars) {
  let text = FALLBACKS[templateType] || '';
  try {
    // Relay messages are delivered over WhatsApp, so the WhatsApp template store
    // (Channels → WhatsApp → Templates) is the authoritative place to customise
    // their wording. Fall back to the shared email_template store, then to the
    // built-in code fallback above.
    let tpl = await loadWhatsAppTemplate(pool, orgId, templateType);
    if (!tpl || !tpl.template_content) tpl = await loadTemplate(pool, orgId, templateType);
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
  for (const ob of outbounds) {
    const eventType = eventTypeForOutbound(ob);
    const { mode, shouldSend } = outboundSendDecision(eventType, setting, new Date());
    const body = await renderMessage(pool, orgId, ob.templateType, ob.vars);
    const id = newId();
    let status = 'draft', sentAt = null;
    let eventId = id;
    let idempotencyKey = null;
    let inserted = false;
    try {
      if (eventType) {
        const [[countRow]] = await pool.execute(
          `SELECT COUNT(*) AS c FROM viewing_negotiation_event
            WHERE negotiation_id = ? AND event_type = ?`,
          [negId, eventType]
        );
        idempotencyKey = idempotencyKeyFor(negId, eventType, (Number(countRow && countRow.c) || 0) + 1);
      }
      await pool.execute(
        `INSERT INTO viewing_negotiation_event
           (id, negotiation_id, direction, party, to_phone, template_type, body, status, sent_at,
            send_mode, event_type, idempotency_key, deadline_at)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, negId, ob.party, ob.to_phone || null, ob.templateType, body, 'draft', null,
         mode, eventType, idempotencyKey, ob.deadlineAt || null]
      );
      inserted = true;
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY' && idempotencyKey) {
        const [[existing]] = await pool.execute(
          `SELECT id, status, sent_at FROM viewing_negotiation_event WHERE idempotency_key = ? LIMIT 1`,
          [idempotencyKey]
        );
        eventId = existing ? String(existing.id) : id;
        status = existing ? existing.status : 'draft';
        sentAt = existing ? existing.sent_at : null;
      } else if (isSchemaMissingError(e)) {
        await pool.execute(
          `INSERT INTO viewing_negotiation_event
             (id, negotiation_id, direction, party, to_phone, template_type, body, status, sent_at)
           VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
          [id, negId, ob.party, ob.to_phone || null, ob.templateType, body, 'draft', null]
        );
        inserted = true;
      } else {
        throw e;
      }
    }
    if (inserted && shouldSend && ob.to_phone) {
      let ok = false;
      try { const r = await sendWhatsApp(pool, orgId, ob.to_phone, body); ok = !!(r && r.ok); }
      catch (e) { console.error('[viewingNegotiation] sendWhatsApp failed:', e.message); }
      if (ok) {
        status = 'sent'; sentAt = new Date();
        await pool.execute(
          `UPDATE viewing_negotiation_event SET status = 'sent', sent_at = ? WHERE id = ?`,
          [sentAt, eventId]
        );
      }
    }
    events.push({
      id: eventId, party: ob.party, to_phone: ob.to_phone, template_type: ob.templateType,
      body, status, send_mode: mode, event_type: eventType, deadline_at: ob.deadlineAt || null,
    });
    if (status === 'sent') await applySentEventSideEffects(pool, orgId, eventId, sentAt || new Date());
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

async function loadStoredAccessPolicy(pool, unitId, tenantId) {
  if (!unitId || !tenantId) return null;
  try {
    const [[row]] = await pool.execute(
      `SELECT * FROM viewing_access_policy WHERE unit_id = ? AND tenant_id = ? LIMIT 1`,
      [unitId, tenantId]
    );
    return row || null;
  } catch (e) {
    if (isSchemaMissingError(e)) return null;
    throw e;
  }
}

function callerPolicyFromNegotiation(neg) {
  if (!neg) return null;
  if (neg.policy_opt_out_hours == null && neg.policy_explicit_confirm == null) return null;
  return {
    opt_out_window_hours: neg.policy_opt_out_hours,
    require_explicit_confirmation: neg.policy_explicit_confirm == null ? undefined : Boolean(neg.policy_explicit_confirm),
  };
}

async function applySentEventSideEffects(pool, orgId, eventId, sentAt = new Date()) {
  try {
    const [[ev]] = await pool.execute(
      `SELECT e.id, e.event_type, e.status, e.deadline_at, n.id AS negotiation_id,
              n.current_proposed_datetime, n.policy_opt_out_hours, n.policy_explicit_confirm
         FROM viewing_negotiation_event e
         JOIN viewing_negotiation n ON n.id = e.negotiation_id
        WHERE e.id = ? LIMIT 1`,
      [eventId]
    );
    if (!ev || ev.status !== 'sent') return;
    if (ev.event_type === 'customer_confirm_request') {
      await pool.execute(
        `UPDATE viewing_negotiation SET customer_asked_at = ?, updated_at = updated_at WHERE id = ?`,
        [sentAt, ev.negotiation_id]
      );
      return;
    }
    if (!['tenant_opt_out_notice', 'tenant_explicit_confirm_request'].includes(ev.event_type)) return;

    const setting = await getSetting(pool, orgId);
    const policy = resolvePolicy({
      callerPolicy: {
        opt_out_window_hours: ev.policy_opt_out_hours,
        require_explicit_confirmation: ev.policy_explicit_confirm == null ? undefined : Boolean(ev.policy_explicit_confirm),
      },
      setting,
      viewingStartAt: dateToWallClock(ev.current_proposed_datetime),
      noticeSentAt: sentAt,
    });
    // The deadline the tenant was ACTUALLY SHOWN is the only one we may act on.
    // It was rendered into the message body at composition time and stored on the
    // event row; we must not recompute it here. In manual relay mode (the default)
    // composition and approval can be hours apart, so recomputing from `sentAt`
    // would enforce a deadline that appears nowhere in the message the tenant read —
    // and auto-confirming off that is not informed consent, it is a guess.
    const staleNotice = ev.event_type === 'tenant_opt_out_notice'
      && !noticeIsActionable({ quotedDeadlineAt: ev.deadline_at, sentAt });

    if (ev.event_type === 'tenant_explicit_confirm_request' || policy.require_explicit_confirmation
        || staleNotice) {
      // Staff may approve an opt-out draft hours later, by which time either short
      // notice or an expired quoted deadline makes silence unsafe. Force explicit
      // confirmation from that point and leave no deadline, so silence cannot confirm.
      await pool.execute(
        `UPDATE viewing_negotiation
            SET tenant_notified_at = ?, opt_out_deadline_at = NULL,
                policy_opt_out_hours = ?, policy_explicit_confirm = 1, policy_source = ?,
                updated_at = updated_at
          WHERE id = ?`,
        [sentAt, policy.opt_out_window_hours, staleNotice ? 'stale_notice' : policy.source, ev.negotiation_id]
      );
      if (staleNotice) {
        // The tenant received a deadline that had already lapsed. We will not act on
        // their silence, so a human has to close the loop.
        notifyStaff(pool, orgId, 'Viewing notice approved too late',
          'A tenant opt-out notice was approved after the deadline it quoted had passed. '
          + 'The viewing will NOT auto-confirm — please confirm with the occupant directly.');
      }
      return;
    }
    await pool.execute(
      `UPDATE viewing_negotiation
          SET tenant_notified_at = ?, opt_out_deadline_at = ?,
              policy_opt_out_hours = ?, policy_explicit_confirm = 0, policy_source = ?,
              updated_at = updated_at
        WHERE id = ?`,
      [sentAt, ev.deadline_at, policy.opt_out_window_hours, policy.source, ev.negotiation_id]
    );
  } catch (e) {
    if (!isSchemaMissingError(e)) throw e;
  }
}

async function applySentSideEffectsFromEvents(pool, orgId, events) {
  for (const ev of events || []) {
    if (ev && ev.status === 'sent') await applySentEventSideEffects(pool, orgId, ev.id, new Date());
  }
}

// ── booking confirmation ──────────────────────────────────────────────────────
async function confirmNegotiation(pool, orgId, neg, whenIso, staff, options = {}) {
  const finalState = options.finalState || 'CONFIRMED';
  const reason = options.reason || null;
  // Atomically CLAIM the negotiation first: a single UPDATE flips it to the
  // terminal state only if it isn't already terminal. Two concurrent replies race
  // here; the loser gets affectedRows=0 and MUST NOT create a second booking.
  const terminalPlaceholders = TERMINAL_STATES.map(() => '?').join(', ');
  let claim;
  try {
    [claim] = await pool.execute(
      `UPDATE viewing_negotiation
          SET state = ?, awaiting = NULL, closed_at = NOW(), reversal_reason = COALESCE(?, reversal_reason)
        WHERE id = ? AND state NOT IN (${terminalPlaceholders})`,
      [finalState, reason, neg.id, ...TERMINAL_STATES]
    );
  } catch (e) {
    if (!isSchemaMissingError(e)) throw e;
    [claim] = await pool.execute(
      `UPDATE viewing_negotiation SET state = ?, awaiting = NULL, closed_at = NOW()
        WHERE id = ? AND state NOT IN (${terminalPlaceholders})`,
      [finalState, neg.id, ...TERMINAL_STATES]
    );
  }
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
  // Clear the tentative projection before creating the confirmed event, so the
  // staffer does not briefly see the same viewing twice.
  await clearCalendarHold(pool, orgId, neg)
    .catch(e => console.error('[viewingNegotiation] clear hold before confirm failed:', e.message));
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
          AND state NOT IN (${sqlList(CLOSED_STATES)})
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
  // Window gate: an OCCUPIED unit only engages the current tenant when their
  // lease ends within the per-status lead window (NR=lead_days_nr, else
  // lead_days_other). Outside it we DON'T reject the prospect — we park the
  // request as NEEDS_STAFF, soft-hold the prospect, and notify staff, who can
  // "Start viewing anyway" from the dashboard. Vacant units (no lease) skip this.
  if (lease && lease.id) {
    const win = viewingWindow({
      endDate: lease.end_date, contractType: lease.contract_type,
      leadDaysNr: setting.lead_days_nr, leadDaysOther: setting.lead_days_other, today: todayYmd(),
    });
    if (!win.inWindow) {
      // Idempotent: reuse an existing open off-window hold for this unit+prospect.
      if (prospect.phone) {
        const [[held]] = await pool.execute(
          `SELECT id, state, awaiting, prospect_phone FROM viewing_negotiation
            WHERE unit_id = ? AND prospect_phone = ? AND state = 'NEEDS_STAFF'
              AND needs_staff_reason = 'off_window'
            ORDER BY created_at DESC LIMIT 1`,
          [unit.id, prospect.phone]
        );
        if (held) {
          return {
            negotiation_id: String(held.id), state: held.state, awaiting: held.awaiting,
            events: [], reused: true, off_window: true, ...buildRouting(held, tenantPhone),
          };
        }
      }
      const heldId = newId();
      await pool.execute(
        `INSERT INTO viewing_negotiation
           (id, org_id, unit_id, property_id, lease_id, tenant_id, prospect_name, prospect_phone, prospect_email,
            state, awaiting, needs_staff_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEEDS_STAFF', 'staff', 'off_window')`,
        [heldId, orgId, unit.id, unit.property_id, lease.id, tenantId,
         prospect.name || null, prospect.phone || null, prospect.email || null]
      );
      const holdVars = { '%Unit Name%': unit.unit_name, '%Property Name%': unit.property_name };
      const events = await dispatchOutbounds(pool, orgId, heldId, setting, [
        { party: 'prospect', to_phone: prospect.phone, templateType: 'Viewing-Hold-OffWindow', vars: holdVars },
      ]);
      const endLabel = lease.end_date || 'no end date';
      await notifyStaff(pool, orgId, 'Viewing request needs review',
        `${prospect.name || prospect.phone || 'A prospect'} asked to view ${unit.unit_name} at ${unit.property_name}, but the current lease ends ${endLabel} (outside the ${win.leadDays}-day window). Open Viewing Requests to Start viewing anyway.`);
      return {
        negotiation_id: heldId, state: 'NEEDS_STAFF', awaiting: 'staff', off_window: true, events,
        ...buildRouting({ prospect_phone: prospect.phone || null, awaiting: 'staff' }, tenantPhone),
      };
    }
  }
  const negId = newId();
  await pool.execute(
    `INSERT INTO viewing_negotiation
       (id, org_id, unit_id, property_id, lease_id, tenant_id, prospect_name, prospect_phone, prospect_email,
        state, awaiting)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASK_PROSPECT_DAY', 'prospect')`,
    [negId, orgId, unit.id, unit.property_id, lease ? lease.id : null, tenantId,
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

// Start a negotiation from raw TEXT ("mongkok 6a") instead of a known unit_id.
// Tenafy resolves it; if it isn't a confident single match, the first message
// reconfirms/disambiguates (CONFIRM_UNIT / RESOLVE_UNIT) before the day-ask. Once
// the prospect confirms/picks, pinUnitAndProceed runs the normal marketable+window
// gate. The unit/property are NULL on the row until then.
async function startNegotiationFromText(pool, orgId, { unitText, prospect }) {
  const setting = await getSetting(pool, orgId);
  // Dedupe a double button-press: reuse an open (non-terminal) negotiation for
  // this prospect phone rather than spawning a second resolving thread.
  if (prospect.phone) {
    const [[existing]] = await pool.execute(
      `SELECT id, state, awaiting, prospect_phone FROM viewing_negotiation
        WHERE prospect_phone = ? AND state NOT IN (${sqlList(CLOSED_STATES)})
        ORDER BY created_at DESC LIMIT 1`,
      [prospect.phone]
    );
    if (existing) {
      return {
        negotiation_id: String(existing.id), state: existing.state, awaiting: existing.awaiting,
        events: [], reused: true, ...buildRouting(existing, null),
      };
    }
  }
  const negId = newId();
  await pool.execute(
    `INSERT INTO viewing_negotiation
       (id, org_id, prospect_name, prospect_phone, prospect_email, state, awaiting, pending_unit_text)
     VALUES (?, ?, ?, ?, ?, 'RESOLVE_UNIT', 'prospect', ?)`,
    [negId, orgId, prospect.name || null, prospect.phone || null, prospect.email || null,
     unitText ? String(unitText).slice(0, 255) : null]
  );
  const { set, outbounds } = await computeResolutionPlan(pool, orgId, unitText, prospect.phone);
  const cols = Object.keys(set);
  if (cols.length) {
    await pool.execute(
      `UPDATE viewing_negotiation SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map(c => set[c]), negId]
    );
  }
  const events = await dispatchOutbounds(pool, orgId, negId, setting, outbounds);
  const fresh = await loadNegotiation(pool, negId);
  return {
    negotiation_id: negId, state: fresh.state, awaiting: fresh.awaiting, events,
    ...buildRouting(fresh, null),
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
    pendingWhen: dateToWallClock(neg.pending_datetime),
    // Unit resolution phase (RESOLVE_UNIT / CONFIRM_UNIT): a fresh unit name, a
    // numbered pick from the offered list, or a text label.
    unit_text: rawIntent && rawIntent.unit_text ? String(rawIntent.unit_text) : undefined,
    index: rawIntent && rawIntent.index != null ? Number(rawIntent.index) : undefined,
    choice: rawIntent && rawIntent.choice ? String(rawIntent.choice) : undefined,
  };
  await logInbound(pool, neg.id, party, rawIntent, rawText, messageId);

  const baseVars = {
    '%Unit Name%': ctx.unit_name || '', '%Property Name%': ctx.property_name || '',
    '%Property Address%': ctx.address || '', '%Prospect Name%': neg.prospect_name || '',
    '%Tenant Name%': tenantDisplayName(ctx),
  };
  const prospectPhone = neg.prospect_phone;
  const tenantPhone = ctx.tenant_phone;

  const reversal = reversalClassification({ state: neg.state, party, intent });
  if (reversal) {
    await cancelCommittedBookingForNegotiation(pool, neg);
    clearCalendarHold(pool, orgId, neg)
      .catch(e => console.error('[viewingNegotiation] clear hold on reversal failed:', e.message));
    const set = { state: reversal.state, reversal_reason: reversal.reason };
    if (reversal.state === 'NEEDS_STAFF') set.needs_staff_reason = reversal.reason;
    const outbounds = [];
    if (reversal.state === STATE_TENANT_REVERSED) {
      set.awaiting = 'staff';
      outbounds.push({
        party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Reversal-Prospect',
        eventType: 'customer_reversal_notice', vars: baseVars,
      });
      notifyStaff(pool, orgId, 'Viewing reversal needs staff',
        `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'}: tenant can no longer make the auto-confirmed viewing.`);
    } else if (reversal.state === STATE_RESCHEDULE_AFTER_COMMIT) {
      set.awaiting = 'prospect';
      set.current_proposed_datetime = intent.when ? intent.when.slice(0, 19).replace('T', ' ') : null;
      outbounds.push({
        party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Reschedule-Prospect',
        eventType: 'customer_reschedule_request',
        vars: { ...baseVars, '%Proposed Time%': formatWhen(intent.when) },
      });
      notifyStaff(pool, orgId, 'Viewing reschedule needs customer',
        `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'}: tenant proposed ${formatWhen(intent.when)} after confirmation.`);
    } else {
      set.awaiting = 'staff';
      notifyStaff(pool, orgId, 'Tenant replied after confirmation',
        `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'}: review the tenant reply after confirmation.`);
    }
    const cols = Object.keys(set);
    await pool.execute(
      `UPDATE viewing_negotiation SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map(c => set[c]), neg.id]
    );
    const events = await dispatchOutbounds(pool, orgId, neg.id, setting, outbounds);
    const fresh = await loadNegotiation(pool, neg.id);
    return { negotiation: fresh, events, ...buildRouting(fresh, ctx.tenant_phone) };
  }

  // A parseable time that is OUTSIDE the viewing window: tell the sender the
  // reason and keep waiting on them, rather than falling through to the generic
  // "which day?" prompt (which loses why their time was rejected).
  if (intent.windowError && when) {
    const toPhone = party === 'tenant' ? tenantPhone : prospectPhone;
    if (!toPhone) {
      // No way to tell this party why — hand to staff rather than sit silent.
      await pool.execute(
        `UPDATE viewing_negotiation
            SET state = 'NEEDS_STAFF', awaiting = 'staff', needs_staff_reason = 'window_no_phone'
          WHERE id = ?`,
        [neg.id]
      );
      // A human now owns this; do not leave an obsolete tentative calendar hold.
      clearCalendarHold(pool, orgId, neg)
        .catch(e => console.error('[viewingNegotiation] clear hold on escalation failed:', e.message));
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
    readBack: !!setting.read_back, proposedBy: neg.proposed_by,
  });

  const outbounds = [];
  const set = {}; // columns to update on the negotiation row
  let holdSyncRequest = null;
  let clearHoldAfterPersist = false;

  async function doStaffCheck(whenIso, proposedBy, confirmOnFree, roundDelta) {
    const staff = await resolveStaffOfDay(pool, neg.property_id, whenIso);
    if (!staff) {
      return escalatePlan('no_roster', whenIso);
    }
    const { free } = await checkStaffFree(pool, {
      employeeId: staff.employee_id, unitId: neg.unit_id, whenIso,
      buffer: staff.buffer, calendarId: staff.google_calendar_id, excludeNegotiationId: neg.id,
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
    holdSyncRequest = { whenIso, staff };
    const noticeSentAt = new Date();
    const storedPolicy = await loadStoredAccessPolicy(pool, neg.unit_id, neg.tenant_id);
    const policy = resolvePolicy({
      callerPolicy: callerPolicyFromNegotiation(neg),
      storedPolicy,
      setting,
      viewingStartAt: whenIso,
      noticeSentAt,
    });
    const deadline = policy.require_explicit_confirmation ? null
      : optOutDeadline({ noticeSentAt, optOutWindowHours: policy.opt_out_window_hours });
    const tenantNotice = chooseTenantNoticeTemplate(policy, deadline);
    set.policy_opt_out_hours = policy.opt_out_window_hours;
    set.policy_explicit_confirm = policy.require_explicit_confirmation ? 1 : 0;
    set.policy_source = policy.source;
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Checking', vars: vProp });
    outbounds.push({
      party: 'tenant', to_phone: tenantPhone, templateType: tenantNotice.templateType, eventType: tenantNotice.eventType,
      deadlineAt: tenantNotice.deadline ? tenantNotice.deadline.replace('T', ' ') : null,
      vars: { ...vProp, '%Tenant Name%': tenantDisplayName(ctx), '%Opt Out Deadline%': tenantNotice.deadline || '' },
    });
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
    set.needs_staff_reason = reason || null;
    // Once staff owns the exception, a stale tentative block on their calendar
    // is worse than no projection.
    clearHoldAfterPersist = true;
    const vProp = { ...baseVars, '%Proposed Time%': formatWhen(whenIso || neg.current_proposed_datetime) };
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Relay-Escalated', vars: vProp });
    if (hasTenant && tenantPhone) {
      outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Relay-Escalated', vars: vProp });
    }
    notifyStaff(pool, orgId, 'Viewing needs staff',
      `${neg.prospect_name || 'A prospect'} — ${ctx.unit_name || 'unit'} at ${ctx.property_name || ''} (${reason})`);
  }

  // Relay a tenant's (confirmed) counter to the prospect, after staff-validating it.
  async function doRelayToProspect(whenIso, oldWhen, roundDelta) {
    const staff = await resolveStaffOfDay(pool, neg.property_id, whenIso);
    if (!staff) { escalatePlan('no_roster', whenIso); return; }
    const { free } = await checkStaffFree(pool, {
      employeeId: staff.employee_id, unitId: neg.unit_id, whenIso,
      buffer: staff.buffer, calendarId: staff.google_calendar_id, excludeNegotiationId: neg.id,
    });
    if (!free) {
      // No staff that day → ask the tenant for another time (not a relayed round).
      set.state = 'ASK_TENANT_ALT'; set.awaiting = 'tenant';
      outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Tenant-Alt-Ask', vars: baseVars });
      return;
    }
    set.round_count = neg.round_count + (roundDelta || 0);
    set.current_proposed_datetime = whenIso.slice(0, 19).replace('T', ' ');
    set.proposed_by = 'tenant';
    set.staff_employee_id = staff.employee_id;
    set.state = 'RELAY_TO_PROSPECT'; set.awaiting = 'prospect';
    holdSyncRequest = { whenIso, staff };
    outbounds.push({
      party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Relay-Prospect',
      vars: { ...baseVars, '%Proposed Time%': formatWhen(whenIso), '%Old Time%': formatWhen(oldWhen) },
    });
  }

  // Pin a resolved/confirmed unit onto the negotiation and run the marketable +
  // window gate: in-window → ASK_PROSPECT_DAY; off-window → off_window hold;
  // occupied-but-disabled → not_marketing hold; vacant-without-host → no_host.
  async function pinUnitAndProceed(unitId) {
    const [[u]] = await pool.execute(
      `SELECT u.id, u.name AS unit_name, u.property_id, p.display_name AS property_name
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.id = ? AND p.org_id = ? AND u.active_status = 1 AND u.deleted_at IS NULL LIMIT 1`,
      [unitId, orgId]
    );
    if (!u) { // resolved unit vanished/invalid — back to asking
      set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect';
      set.pending_unit_id = null;
      outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Unit-NotFound', vars: {} });
      return;
    }
    const vars = { '%Unit Name%': u.unit_name, '%Property Name%': u.property_name,
      '%Unit Full Name%': `${u.property_name} ${u.unit_name}` };
    set.unit_id = String(u.id); set.property_id = String(u.property_id);
    set.pending_unit_id = null; set.pending_unit_text = null; set.unit_candidates = null;

    const active = await findActiveLeaseForUnit(pool, unitId); // { leasing_id, tenant_id, contract_type, end_date, viewing_enabled } | null
    const hasRosteredStaff = active ? false : await propertyHasRosteredStaff(pool, u.property_id);
    let hostLink = false;
    if (!active) {
      const [[hl]] = await pool.execute(
        `SELECT 1 FROM viewing_link WHERE unit_id = ? AND status = 1 AND employee_id IS NOT NULL LIMIT 1`, [unitId]);
      hostLink = !!hl;
    }
    set.lease_id = active ? active.leasing_id : null;
    set.tenant_id = active ? active.tenant_id : null;

    const marketability = marketabilityDecision({
      hasActiveLease: !!active,
      viewingEnabled: active ? active.viewing_enabled : 0,
      hasRosteredStaff,
      hasHostLink: hostLink,
    });

    if (!marketability.proceed) {
      // A vacant unit has no occupant to ask, so the only question is whether
      // anyone can let the viewer in, which is what the roster answers.
      // viewing_link belonged to a different, now-abandoned flow (2 rows in
      // production, last booking four months ago) and using it here made 495
      // vacant units unschedulable. The link check is retained only for
      // backwards compatibility with outstanding links, not because it is the
      // right signal. Checking any weekday is deliberate: the viewer has not
      // named a day yet. The specific-day availability check still happens later
      // in staff_check, and the existing !free path asks for another time.
      set.state = 'NEEDS_STAFF'; set.awaiting = 'staff'; set.needs_staff_reason = marketability.reason;
      outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Hold-OffWindow', vars });
      const staffReason = marketability.reason === 'no_host'
        ? 'no rostered host is assigned for the property'
        : "it isn't open for viewings";
      notifyStaff(pool, orgId, 'Viewing request needs review',
        `${neg.prospect_name || prospectPhone || 'A prospect'} asked to view ${u.unit_name} at ${u.property_name}, but ${staffReason}. Open Viewing Requests.`);
      return;
    }
    if (active) {
      const win = viewingWindow({ endDate: active.end_date, contractType: active.contract_type,
        leadDaysNr: setting.lead_days_nr, leadDaysOther: setting.lead_days_other, today: todayYmd() });
      if (!win.inWindow) {
        set.state = 'NEEDS_STAFF'; set.awaiting = 'staff'; set.needs_staff_reason = 'off_window';
        outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Hold-OffWindow', vars });
        const endLabel = active.end_date || 'no end date';
        notifyStaff(pool, orgId, 'Viewing request needs review',
          `${neg.prospect_name || prospectPhone || 'A prospect'} asked to view ${u.unit_name} at ${u.property_name}, but the current lease ends ${endLabel} (outside the ${win.leadDays}-day window). Open Viewing Requests to Start viewing anyway.`);
        return;
      }
    }
    // In-window occupied, or vacant with rostered staff / a compat link, proceeds
    // to the day-ask.
    set.state = 'ASK_PROSPECT_DAY'; set.awaiting = 'prospect'; set.needs_staff_reason = null;
    outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Prospect-Day-Ask', vars });
  }

  if (neg.state === STATE_RESCHEDULE_AFTER_COMMIT && party === 'prospect' && intent.accepted === true) {
    // The tenant proposed this post-commit time themselves, so a customer YES
    // confirms it directly; opening a second tenant opt-out window would ask for
    // consent we already received in the tenant's counter.
    const whenIso = intent.currentWhen;
    const staff = await resolveStaffOfDay(pool, neg.property_id, whenIso);
    if (!staff) {
      escalatePlan('no_roster', whenIso);
    } else {
      const { free } = await checkStaffFree(pool, {
        employeeId: staff.employee_id, unitId: neg.unit_id, whenIso,
        buffer: staff.buffer, calendarId: staff.google_calendar_id, excludeNegotiationId: neg.id,
      });
      if (!free) escalatePlan('slot_taken_at_reconfirm', whenIso);
      else await confirmAndClose(whenIso, staff, { ...baseVars, '%Proposed Time%': formatWhen(whenIso) });
    }
  }

  switch (plan.type) {
    case 'resolve_unit': {
      const p = await computeResolutionPlan(pool, orgId, plan.text, prospectPhone);
      Object.assign(set, p.set);
      for (const ob of p.outbounds) outbounds.push(ob);
      break;
    }
    case 'unit_confirmed':
      if (neg.pending_unit_id) await pinUnitAndProceed(String(neg.pending_unit_id));
      else { set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect';
        outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Unit-NotFound', vars: {} }); }
      break;
    case 'unit_picked': {
      const cands = safeParseCandidates(neg.unit_candidates);
      let picked = null;
      if (plan.index != null && Number.isFinite(plan.index)) {
        const i = Number(plan.index) - 1; // options are 1-based
        if (i >= 0 && i < cands.length) picked = cands[i];
      }
      if (!picked && plan.choice) { // a text label → re-resolve it
        const p = await computeResolutionPlan(pool, orgId, plan.choice, prospectPhone);
        Object.assign(set, p.set);
        for (const ob of p.outbounds) outbounds.push(ob);
        break;
      }
      if (picked) await pinUnitAndProceed(String(picked.unit_id));
      else if (cands.length === 0) { // no list to pick from → ask afresh
        set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect';
        outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Unit-NotFound', vars: {} });
      } else { // out-of-range number → re-list the same candidates
        set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect';
        outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Choose-Unit',
          vars: { '%Unit Options%': optionsText(cands), '%Property Name%': (cands[0] && cands[0].label) || '' } });
      }
      break;
    }
    case 'reask_unit':
      set.state = 'RESOLVE_UNIT'; set.awaiting = 'prospect'; set.pending_unit_id = null;
      outbounds.push({ party: 'prospect', to_phone: prospectPhone, templateType: 'Viewing-Unit-NotFound', vars: {} });
      break;
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
        buffer: staff.buffer, calendarId: staff.google_calendar_id, excludeNegotiationId: neg.id,
      });
      if (!free) { escalatePlan('slot_taken_at_confirm', whenIso); break; }
      await confirmAndClose(whenIso, staff, { ...baseVars, '%Proposed Time%': formatWhen(whenIso) });
      break;
    }
    case 'relay_to_prospect':
      await doRelayToProspect(plan.when, neg.current_proposed_datetime, plan.roundDelta);
      break;
    case 'read_back': {
      // Echo the parsed time+unit back to the proposer and wait for a YES before
      // touching the calendar / messaging the other party. Store it in
      // pending_datetime so the current agreed time (and the tenant-counter "old
      // time") is preserved until confirmation.
      set.pending_datetime = plan.when.slice(0, 19).replace('T', ' ');
      set.proposed_by = plan.proposedBy;
      set.round_count = neg.round_count + (plan.roundDelta || 0);
      set.state = 'CONFIRM_TIME'; set.awaiting = plan.proposedBy;
      const toPhone = plan.proposedBy === 'tenant' ? tenantPhone : prospectPhone;
      outbounds.push({
        party: plan.proposedBy, to_phone: toPhone, templateType: 'Viewing-Confirm-Time',
        vars: { ...baseVars, '%Proposed Time%': formatWhen(plan.when) },
      });
      break;
    }
    case 'confirmed_proceed':
      if (plan.proposedBy === 'prospect') await doStaffCheck(plan.when, 'prospect', false, 0);
      else await doRelayToProspect(plan.when, neg.current_proposed_datetime, 0);
      break;
    case 'ask_tenant_alt':
      set.state = 'ASK_TENANT_ALT'; set.awaiting = 'tenant';
      outbounds.push({ party: 'tenant', to_phone: tenantPhone, templateType: 'Viewing-Tenant-Alt-Ask', vars: baseVars });
      break;
    case 'escalate':
      escalatePlan(plan.reason);
      break;
    case 'cancel':
      set.state = 'CANCELLED'; set.awaiting = null; set.closed_at = new Date();
      clearHoldAfterPersist = true;
      break;
    case 'ignore':
    default:
      break; // logged inbound, nothing else
  }

  // Clear a stale pending read-back time whenever we transition OUT of CONFIRM_TIME.
  if (set.state && set.state !== 'CONFIRM_TIME' && !('pending_datetime' in set)) {
    set.pending_datetime = null;
  }

  // Persist negotiation changes with OPTIMISTIC concurrency: only write if the
  // row is still in the state we loaded. If a concurrent reply already advanced
  // or closed it (e.g. a confirm racing a cancel), our stale write is skipped —
  // the confirm path already persisted its result atomically in confirmNegotiation.
  let wonPersist = true;
  if (Object.keys(set).length) {
    const cols = Object.keys(set);
    let r;
    try {
      [r] = await pool.execute(
        `UPDATE viewing_negotiation SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND state = ?`,
        [...cols.map(c => set[c]), neg.id, neg.state]
      );
    } catch (e) {
      if (!isSchemaMissingError(e)) throw e;
      const legacyCols = cols.filter(c => !V2_NEGOTIATION_COLUMNS.has(c));
      if (!legacyCols.length) {
        r = { affectedRows: 1 };
      } else {
        [r] = await pool.execute(
          `UPDATE viewing_negotiation SET ${legacyCols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND state = ?`,
          [...legacyCols.map(c => set[c]), neg.id, neg.state]
        );
      }
    }
    // Lost the optimistic race (a concurrent reply already advanced this row) →
    // skip sending, so two racing replies can't both dispatch the same message.
    wonPersist = r.affectedRows > 0;
  }
  const events = wonPersist ? await dispatchOutbounds(pool, orgId, neg.id, setting, outbounds) : [];
  const fresh = await loadNegotiation(pool, neg.id);
  if (wonPersist && fresh) {
    if (clearHoldAfterPersist) {
      clearCalendarHold(pool, orgId, fresh)
        .catch(e => console.error('[viewingNegotiation] clear hold failed:', e.message));
    } else if (holdSyncRequest) {
      syncCalendarHold(pool, orgId, fresh, holdSyncRequest)
        .catch(e => console.error('[viewingNegotiation] sync hold failed:', e.message));
    }
  }
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
  await applySentEventSideEffects(pool, orgId, eventId, new Date());
  return { ok: true };
}

// TaneChat manual mode: the bot already SENT the approved draft from inside the
// TaneChat thread — Tenafy does NOT re-send, it just records the outbound as sent
// (single source of truth for the log/dashboard). Atomic claim keeps it idempotent
// and prevents racing the dashboard's approveDraft into a double delivery.
// orgId is unused (the caller org-scopes the event); kept for signature parity
// with approveDraft.
async function markDraftSent(pool, orgId, eventId) {
  const markedAt = new Date();
  const [r] = await pool.execute(
    `UPDATE viewing_negotiation_event SET status = 'sent', sent_at = ?
      WHERE id = ? AND direction = 'out' AND status = 'draft'`,
    [markedAt, eventId]
  );
  if (r.affectedRows > 0) {
    await applySentEventSideEffects(pool, orgId, eventId, markedAt);
    return { ok: true, marked: true, already_sent: false, status: 'sent' };
  }
  // Not a draft anymore — read the REAL status so we never falsely assert a
  // delivery for a non-'sent' terminal state.
  const [[row]] = await pool.execute(
    `SELECT status FROM viewing_negotiation_event WHERE id = ? LIMIT 1`, [eventId]);
  return { ok: true, marked: false, already_sent: row ? row.status === 'sent' : false, status: row ? row.status : null };
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
  clearCalendarHold(pool, orgId, neg)
    .catch(e => console.error('[viewingNegotiation] clear hold on cancel failed:', e.message));
  return { ok: true };
}

async function cancelCommittedBookingForNegotiation(pool, neg) {
  if (!neg || !neg.booking_id) return { cancelled: false, calendar_delete_attempted: false };
  const [[booking]] = await pool.execute(
    `SELECT vb.id, vb.gcal_event_id, u.google_calendar_id AS employee_google_calendar_id
       FROM viewing_booking vb
       LEFT JOIN user u ON u.id = vb.employee_id
      WHERE vb.id = ? LIMIT 1`,
    [neg.booking_id]
  );
  if (!booking) return { cancelled: false, calendar_delete_attempted: false };
  await pool.execute(`UPDATE viewing_candidate SET status = 0 WHERE booking_id = ? AND status = 1`, [booking.id]);
  await pool.execute(`UPDATE viewing_booking SET status = 3, awaiting = NULL WHERE id = ?`, [booking.id]);
  if (booking.gcal_event_id && booking.employee_google_calendar_id) {
    deleteViewingEvent({ calendarId: booking.employee_google_calendar_id, gcalEventId: booking.gcal_event_id })
      .catch(e => console.error('[viewingNegotiation] gcal delete failed:', e.message));
    return { cancelled: true, calendar_delete_attempted: true };
  }
  return { cancelled: true, calendar_delete_attempted: false };
}

// Staff "Start viewing anyway" on a resumable NEEDS_STAFF request: atomically
// claim it back into ASK_PROSPECT_DAY and send the prospect the day-ask,
// honouring relay_mode (manual → draft). No-op if it isn't NEEDS_STAFF or
// already has a booking.
async function proceedNegotiation(pool, orgId, neg) {
  const setting = await getSetting(pool, orgId);
  // Only these holds restart cleanly at the day-ask. multi_unit is deliberately
  // not resumable: the viewer named more than one unit, and resuming would drop
  // back into a flow that still cannot arrange a multi-unit viewing.
  const resumableReasons = RESUMABLE_HOLD_REASONS;
  const reasonPlaceholders = resumableReasons.map(() => '?').join(',');
  const [r] = await pool.execute(
    `UPDATE viewing_negotiation
        SET state = 'ASK_PROSPECT_DAY', awaiting = 'prospect', needs_staff_reason = NULL, updated_at = NOW()
      WHERE id = ? AND state = 'NEEDS_STAFF'
        AND needs_staff_reason IN (${reasonPlaceholders})
        AND booking_id IS NULL`,
    [neg.id, ...resumableReasons]
  );
  if (!r.affectedRows) {
    return { ok: false, message: 'Only an on-hold request with no booking and a resumable reason (off_window, not_marketing, no_host) can be started this way.' };
  }
  const [[u]] = await pool.execute(
    `SELECT u.name AS unit_name, p.display_name AS property_name
       FROM unit u JOIN property p ON u.property_id = p.id WHERE u.id = ? LIMIT 1`,
    [neg.unit_id]
  );
  const vars = { '%Unit Name%': u ? u.unit_name : '', '%Property Name%': u ? u.property_name : '' };
  const events = await dispatchOutbounds(pool, orgId, neg.id, setting, [
    { party: 'prospect', to_phone: neg.prospect_phone, templateType: 'Viewing-Prospect-Day-Ask', vars },
  ]);
  return { ok: true, state: 'ASK_PROSPECT_DAY', awaiting: 'prospect', events };
}

// Reaper (hourly cron): open negotiations with no activity for STALE_HOURS are
// escalated to NEEDS_STAFF so an abandoned/looping conversation doesn't sit open
// forever. A single nudge is sent at REMINDER_HOURS, guarded by reminder_sent_at.
// Guarded for pre-migration orgs.
//
// Both are env-tunable so the cadence can be changed without a deploy. 4h is the
// business requirement: a viewing request that sits unanswered longer than that is
// already costing the booking. The cron runs hourly, so the real nudge lands
// somewhere in [4h, 5h) — a tighter target than that needs a tighter cron, not a
// smaller number here.
const STALE_HOURS = Math.max(1, parseInt(process.env.VIEWING_STALE_HOURS || '24', 10) || 24);
const REMINDER_HOURS = Math.max(1, parseInt(process.env.VIEWING_REMINDER_HOURS || '4', 10) || 4);
// A reminder window that starts at or after the escalation cutoff can never select a
// row (the query needs updated_at in [REMINDER_HOURS, STALE_HOURS)), so the nudge
// would silently never fire. Fail loudly at boot instead of at 3am in six weeks.
if (REMINDER_HOURS >= STALE_HOURS) {
  console.warn(
    `[viewingNegotiation] VIEWING_REMINDER_HOURS (${REMINDER_HOURS}) >= VIEWING_STALE_HOURS ` +
    `(${STALE_HOURS}) — no reminder can ever be sent. Lower the reminder or raise the stale window.`
  );
}

function isSchemaMissingError(err) {
  return /doesn't exist|Unknown column|Unknown table/i.test(err && err.message);
}

function viewingNegotiationVars(ctx) {
  return {
    '%Unit Name%': (ctx && ctx.unit_name) || '',
    '%Property Name%': (ctx && ctx.property_name) || '',
  };
}

async function autoEscalateStaleNegotiationsForOrg(pool, orgId) {
  try {
    const setting = await getSetting(pool, orgId);
    const staleHours = Math.max(1, Number(setting.customer_timeout_hours) || STALE_HOURS);

    try {
      const [autoRows] = await pool.execute(
        `SELECT *
           FROM viewing_negotiation
          WHERE state = 'AWAIT_TENANT' AND awaiting = 'tenant'
            AND tenant_notified_at IS NOT NULL
            AND policy_explicit_confirm = 0
            AND opt_out_deadline_at IS NOT NULL
            AND opt_out_deadline_at <= NOW()
          ORDER BY opt_out_deadline_at ASC
          LIMIT 200`
      );
      for (const neg of autoRows) {
        try {
          const decision = autoConfirmDecision(neg, new Date());
          if (decision.action !== 'auto_confirm') continue;
          const whenIso = dateToWallClock(neg.current_proposed_datetime);
          const staff = await resolveStaffOfDay(pool, neg.property_id, whenIso);
          let free = false;
          if (staff) {
            const checked = await checkStaffFree(pool, {
              employeeId: staff.employee_id, unitId: neg.unit_id, whenIso,
              buffer: staff.buffer, calendarId: staff.google_calendar_id, excludeNegotiationId: neg.id,
            });
            free = !!checked.free;
          }
          if (!staff || !free) {
            const [claim] = await pool.execute(
              `UPDATE viewing_negotiation
                  SET state = 'NEEDS_STAFF', awaiting = 'staff', needs_staff_reason = 'auto_confirm_no_staff',
                      updated_at = updated_at
                WHERE id = ? AND state = 'AWAIT_TENANT'`,
              [neg.id]
            );
            if (claim.affectedRows) {
              clearCalendarHold(pool, orgId, neg)
                .catch(e => console.error('[viewingNegotiation] clear hold on auto-confirm escalation failed:', e.message));
              notifyStaff(pool, orgId, 'Viewing needs staff',
                `${neg.prospect_name || 'A prospect'} — auto-confirm window elapsed but no staff is free.`);
            }
            continue;
          }
          await pool.execute(
            `UPDATE viewing_negotiation SET auto_confirmed_at = NOW(), updated_at = updated_at WHERE id = ?`,
            [neg.id]
          );
          const r = await confirmNegotiation(pool, orgId, neg, whenIso, staff, { finalState: STATE_AUTO_CONFIRMED });
          if (r && r.skipped) continue;
          // The tenant was told the deadline and their silence was the answer.
          // Sending them a second "confirmed" note would imply we needed an
          // agreement after telling them we did not.
          await dispatchOutbounds(pool, orgId, neg.id, setting, [{
            party: 'prospect',
            to_phone: neg.prospect_phone,
            templateType: 'Viewing-Relay-Confirmed',
            vars: { ...viewingNegotiationVars(r.ctx), '%Proposed Time%': formatWhen(whenIso) },
          }]);
        } catch (err) {
          if (isSchemaMissingError(err)) throw err;
          console.error(`[Scheduler] auto-confirm failed for negotiation ${neg.id}:`, err.message);
        }
      }
    } catch (err) {
      if (!isSchemaMissingError(err)) throw err;
    }

    try {
      const [reminders] = await pool.execute(
        `SELECT id, org_id, unit_id, property_id, tenant_id, prospect_name, prospect_phone,
                awaiting, reminder_sent_at, TIMESTAMPDIFF(HOUR, updated_at, NOW()) AS hoursIdle
           FROM viewing_negotiation
          WHERE state NOT IN (${sqlList(CLOSED_STATES)})
            AND reminder_sent_at IS NULL
            AND awaiting IN ('prospect', 'tenant')
            AND updated_at < DATE_SUB(NOW(), INTERVAL ${REMINDER_HOURS} HOUR)
            AND updated_at >= DATE_SUB(NOW(), INTERVAL ${staleHours} HOUR)
          ORDER BY updated_at ASC
          LIMIT 200`
      );
      for (const neg of reminders) {
        try {
          // Pass the configured thresholds explicitly. The helper has its own
          // defaults, and letting them apply here would mean the SQL selected on one
          // window while the guard rejected on another — nothing would ever be sent.
          const party = reminderTarget(neg, { reminderHours: REMINDER_HOURS, staleHours });
          if (!party) continue;
          const ctx = await loadContext(pool, neg);
          const toPhone = party === 'tenant' ? ctx.tenant_phone : neg.prospect_phone;
          if (!toPhone) {
            console.warn(`[Scheduler] viewing reminder skipped: negotiation ${neg.id} has no ${party} phone`);
            continue;
          }
          // Claim the reminder before dispatch. reminder_sent_at is the only
          // resend guard, so a missed nudge is preferable to hourly duplicates.
          const [claim] = await pool.execute(
            `UPDATE viewing_negotiation
                SET reminder_sent_at = NOW(), updated_at = updated_at
              WHERE id = ?
                AND reminder_sent_at IS NULL
                AND state NOT IN (${sqlList(CLOSED_STATES)})`,
            [neg.id]
          );
          if (claim.affectedRows === 0) continue;
          await dispatchOutbounds(pool, orgId, neg.id, setting, [{
            party,
            to_phone: toPhone,
            templateType: 'Viewing-Relay-Reminder',
            vars: viewingNegotiationVars(ctx),
          }]);
        } catch (err) {
          if (isSchemaMissingError(err)) throw err;
          console.error(`[Scheduler] viewing reminder failed for negotiation ${neg.id}:`, err.message);
        }
      }
    } catch (err) {
      if (!isSchemaMissingError(err)) throw err;
    }

    const [stale] = await pool.execute(
      `SELECT *
        FROM viewing_negotiation
        WHERE state NOT IN (${sqlList(CLOSED_STATES)})
          AND updated_at < DATE_SUB(NOW(), INTERVAL ${staleHours} HOUR)
        ORDER BY updated_at ASC
        LIMIT 200`
    );
    let escalated = 0;
    for (const neg of stale) {
      try {
        const [claim] = await pool.execute(
          `UPDATE viewing_negotiation
              SET state = 'NEEDS_STAFF', awaiting = 'staff', needs_staff_reason = 'stale'
            WHERE id = ?
              AND state NOT IN (${sqlList(CLOSED_STATES)})`,
          [neg.id]
        );
        if (claim.affectedRows === 0) continue;
        escalated += 1;
        clearCalendarHold(pool, orgId, neg)
          .catch(e => console.error('[viewingNegotiation] clear hold on stale escalation failed:', e.message));

        const ctx = await loadContext(pool, neg);
        const vars = {
          ...viewingNegotiationVars(ctx),
          '%Proposed Time%': formatWhen(neg.current_proposed_datetime),
        };
        const outbounds = [
          { party: 'prospect', to_phone: neg.prospect_phone, templateType: 'Viewing-Relay-Escalated', vars },
        ];
        if (ctx.hasTenant && ctx.tenant_phone) {
          outbounds.push({ party: 'tenant', to_phone: ctx.tenant_phone, templateType: 'Viewing-Relay-Escalated', vars });
        }
        await dispatchOutbounds(pool, orgId, neg.id, setting, outbounds);
      } catch (err) {
        if (isSchemaMissingError(err)) throw err;
        console.error(`[Scheduler] stale viewing escalation failed for negotiation ${neg.id}:`, err.message);
      }
    }
    if (escalated > 0) {
      console.log(`[Scheduler] Escalated ${escalated} stale viewing negotiation(s) to staff`);
      notifyStaff(pool, orgId, 'Viewing requests need staff',
        `${escalated} viewing request(s) had no activity for ${staleHours}h and were handed to your team.`);
    }
  } catch (err) {
    if (!isSchemaMissingError(err)) {
      console.error('[Scheduler] stale-negotiation reap failed:', err.message);
    }
  }
}

module.exports = {
  // pure / helpers (tested)
  nextStep, combineDateTime, withinWindow, viewingWindow, marketabilityDecision, minutesOf,
  RESUMABLE_HOLD_REASONS,
  reminderTarget, activeNegotiationPayload,
  DEFAULT_SETTING, STATE_AUTO_CONFIRMED, STATE_TENANT_REVERSED, STATE_RESCHEDULE_AFTER_COMMIT,
  TERMINAL_STATES, CLOSED_STATES, EVENT_TYPES, EVENT_TYPE_BY_TEMPLATE,
  resolvePolicy, optOutDeadline, noticeIsActionable, autoConfirmDecision, nudgeDecision,
  reversalClassification,
  sendModeFor, idempotencyKeyFor, withinQuietHours, draftQueryOptions,
  eventTypeForOutbound, outboundSendDecision, chooseTenantNoticeTemplate,
  boardNextDeadline, isNudgeCandidate, isStaleCandidate, isSchemaMissingError, dateToWallClock,
  // orchestration
  getSetting, startNegotiation, startNegotiationFromText, handleReply, loadNegotiation,
  resolveStaffOfDay, loadStaffById, checkStaffFree, confirmNegotiation,
  approveDraft, markDraftSent, staffMessage, cancelNegotiation, proceedNegotiation, loadContext,
  autoEscalateStaleNegotiationsForOrg,
};

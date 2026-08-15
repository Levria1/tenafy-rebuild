/**
 * Pure logic for the Viewing Relay Scheduler state machine.
 *
 * NO heavy/side-effecting imports (no googleapis, no DB) so it loads instantly
 * and is unit-testable in isolation. services/viewingNegotiation.js re-exports
 * everything here and adds the async orchestration (DB, calendar, sending).
 */

const DEFAULT_SETTING = {
  relay_mode: 'manual', max_rounds: 3, read_back: 1,
  viewing_days: '1,2,3,4,5,6', viewing_start: '11:00:00', viewing_end: '19:00:00',
  lead_days_nr: 60, lead_days_other: 45,
  customer_nudge_1_hours: 1, customer_nudge_2_hours: 6, customer_nudge_cap: 2,
  customer_timeout_hours: 24, tenant_opt_out_hours: 4, tenant_explicit_timeout_hours: 24,
  tenant_nudge_cap: 1, auto_send_nudges: 0, respect_quiet_hours: 1,
};

const STATE_AUTO_CONFIRMED = 'AUTO_CONFIRMED';
const STATE_TENANT_REVERSED = 'TENANT_CANCELS_AFTER_X';
const STATE_RESCHEDULE_AFTER_COMMIT = 'RESCHEDULE_AFTER_COMMIT';
const TERMINAL_STATES = ['CONFIRMED', STATE_AUTO_CONFIRMED, 'CANCELLED'];
const CLOSED_STATES = [...TERMINAL_STATES, 'NEEDS_STAFF'];
// A draft is a short-lived suggestion, not a stored artifact. Past this it is no
// longer offered for sending — staff ask for a fresh one instead of releasing a
// message composed against facts that may have moved.
const DRAFT_FRESH_MINUTES = 30;

// The current tenant is only contacted when their lease ends within a lead
// window that depends on renewal status: Not Renewing (contract_type 3) gets
// the longer `lead_days_nr`, everything else (MTM/MR/UC/unset) `lead_days_other`.
// `endDate`/`today` are 'YYYY-MM-DD' (dates only — the day the lease ends is what
// matters, not the hour). Returns { inWindow, leadDays, reason }.
//   reason: 'ok' | 'beyond_window' | 'no_end_date' | 'bad_date'
function viewingWindow({ endDate, contractType, leadDaysNr, leadDaysOther, today }) {
  const nr = Number(leadDaysNr); const other = Number(leadDaysOther);
  const leadDays = Number(contractType) === 3
    ? (Number.isFinite(nr) ? nr : DEFAULT_SETTING.lead_days_nr)
    : (Number.isFinite(other) ? other : DEFAULT_SETTING.lead_days_other);
  if (!endDate) return { inWindow: false, leadDays, reason: 'no_end_date' };
  const em = String(endDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const tm = String(today).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!em || !tm) return { inWindow: false, leadDays, reason: 'bad_date' };
  const end = Date.UTC(+em[1], +em[2] - 1, +em[3]);
  const now = Date.UTC(+tm[1], +tm[2] - 1, +tm[3]);
  const daysToEnd = Math.round((end - now) / 86400000);
  // Inside the window when the lease ends within leadDays from today. A lease
  // that already ended (holdover) still counts as in-window (daysToEnd <= leadDays).
  return { inWindow: daysToEnd <= leadDays, leadDays, reason: daysToEnd <= leadDays ? 'ok' : 'beyond_window' };
}

function marketabilityDecision(facts = {}) {
  if (facts.hasActiveLease) {
    return Number(facts.viewingEnabled) === 1 || facts.viewingEnabled === true
      ? { proceed: true, reason: null }
      : { proceed: false, reason: 'not_marketing' };
  }
  return facts.hasRosteredStaff || facts.hasHostLink
    ? { proceed: true, reason: null }
    : { proceed: false, reason: 'no_host' };
}

const RESUMABLE_HOLD_REASONS = ['off_window', 'not_marketing', 'no_host'];

function isResumableHold(reason) {
  return RESUMABLE_HOLD_REASONS.includes(reason);
}

// Combine assorted intent time shapes into canonical 'YYYY-MM-DDTHH:mm:00'.
function combineDateTime(intent) {
  if (!intent) return null;
  const raw = intent.datetime || intent.when
    || (intent.date && intent.time ? `${intent.date}T${intent.time}` : null);
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const HH = String(m[4]).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]}T${HH}:${m[5]}:00`;
}

function minutesOf(timeStr) {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? (+m[1] * 60 + +m[2]) : 0;
}

function dateLikeToLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return isNaN(copy.getTime()) ? null : copy;
  }
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}

// The operator's wall clock, which is NOT the server's.
//
// The droplet, node and MySQL all run UTC; the operator is in Hong Kong and both
// configures viewing hours and receives prospect times as HK wall clock. Deriving
// "now" with local getters therefore reads 8 hours early, which inverts the
// quiet-hours window and — worse — makes a viewing an hour away look like nine,
// defeating the short-notice rule that forces explicit tenant consent.
//
// An IANA zone rather than a fixed offset: HK has no DST so the numbers are the
// same today, but a fixed offset silently becomes wrong the first time this runs
// anywhere else. We deliberately do NOT set process.env.TZ — mysql2 parses stored
// DATETIMEs against the process timezone, so changing it would reinterpret every
// timestamp already in the database.
// These moved to utils/orgTime.js so the scheduler and the viewing relay read the
// same clock. Re-exported below, unchanged, so every existing caller and test keeps
// importing them from here.
const { ORG_TIME_ZONE, orgWallClock, toOrgWallClock } = require('../utils/orgTime');

function dateToWallClockMinute(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// Returns null if `whenIso` is within the org viewing window, else an error string.
// `nowWallClock` is injectable so the past-check is testable deterministically;
// it defaults to the operator clock, never the server's.
function withinWindow(whenIso, setting, nowWallClock = orgWallClock()) {
  setting = setting || DEFAULT_SETTING;
  const m = String(whenIso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return 'Invalid date/time';
  const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 0=Sun
  const days = String(setting.viewing_days || DEFAULT_SETTING.viewing_days)
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  if (!days.includes(dow)) return 'Outside viewing days';
  const startMin = +m[4] * 60 + +m[5];
  if (startMin < minutesOf(setting.viewing_start)) return 'Before opening time';
  if (startMin + 30 > minutesOf(setting.viewing_end)) return 'After closing time';
  // Compare wall clock with wall clock. `whenIso` carries no zone and means the
  // OPERATOR's local time, so parsing it into an instant on a UTC server reads it
  // 8 hours late and lets a time that has already passed look like the future.
  // Both sides are zero-padded YYYY-MM-DDTHH:MM:SS, so string order is time order.
  if (String(whenIso) < String(nowWallClock)) return 'In the past';
  return null;
}

function resolvePolicy({ callerPolicy, storedPolicy, setting, viewingStartAt, noticeSentAt } = {}) {
  // `viewingStartAt` is OPERATOR wall clock (a prospect's "Tuesday 3pm"), while
  // callers naturally hand us a real instant for `noticeSentAt` (new Date()).
  // Comparing those directly on a UTC server inflates the gap by 8 hours, so a
  // viewing an hour away reads as nine and skips the short-notice rule that
  // forces explicit tenant consent. Normalise here rather than at each call site:
  // a caller that forgets is silent, and the failure is a real viewing confirmed
  // without the occupant having any chance to object.
  noticeSentAt = toOrgWallClock(noticeSentAt);
  const choices = [
    { source: 'caller', policy: callerPolicy },
    { source: 'stored', policy: storedPolicy },
    { source: 'setting', policy: { opt_out_window_hours: setting && setting.tenant_opt_out_hours } },
    { source: 'setting', policy: { opt_out_window_hours: 4 } },
  ];

  // The two fields resolve INDEPENDENTLY. They are separate decisions, and
  // resolving them together loses the safety-critical one: viewing_access_policy
  // allows opt_out_window_hours to be NULL, so an operator who ticks "this tenant
  // must say yes" and leaves the hours blank would have had the whole row skipped
  // for a missing optional field — silently reverting them to silence-is-consent.
  let resolved = { opt_out_window_hours: 4, require_explicit_confirmation: false, source: 'setting' };
  for (const choice of choices) {
    const hours = Number(choice.policy && choice.policy.opt_out_window_hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) continue;
    resolved.opt_out_window_hours = hours;
    resolved.source = choice.source;
    break;
  }
  for (const choice of choices) {
    const flag = choice.policy && choice.policy.require_explicit_confirmation;
    if (flag == null) continue; // absent — defer to the next source, don't read it as false
    resolved.require_explicit_confirmation = Boolean(flag);
    // A source that only carries the flag still owns the decision that matters.
    if (choice.source !== 'setting' && resolved.source === 'setting') resolved.source = choice.source;
    break;
  }

  const viewingStart = dateLikeToLocalDate(viewingStartAt);
  const noticeSent = dateLikeToLocalDate(noticeSentAt);
  if (viewingStart && noticeSent) {
    const noticeHours = (viewingStart.getTime() - noticeSent.getTime()) / 3600000;
    // If the viewing starts sooner than the window we promised the tenant to
    // object in, silence cannot possibly be informed consent — they may not even
    // have read it yet. A past viewing is the same rule in degenerate form.
    if (noticeHours < resolved.opt_out_window_hours) {
      return { ...resolved, require_explicit_confirmation: true, source: 'short_notice' };
    }
  }
  return resolved;
}

function optOutDeadline({ noticeSentAt, optOutWindowHours } = {}) {
  const noticeSent = dateLikeToLocalDate(noticeSentAt);
  if (!noticeSent) return null;
  const hours = Number(optOutWindowHours);
  if (!Number.isFinite(hours)) return null;
  const deadline = new Date(noticeSent.getTime() + hours * 3600000);
  return dateToWallClockMinute(deadline);
}

// Can we still act on a historical tenant notice against the deadline they were SHOWN?
//
// Old opt-out templates rendered a deadline into the message body at composition
// time. In manual relay mode staff approve that draft later, so the quoted
// deadline is the only one the tenant saw and cannot be recomputed at send time.
// New silence-confirm asks do not show a deadline and do not use this check.
function noticeIsActionable({ quotedDeadlineAt, sentAt, minRemainingMs = 3600000 } = {}) {
  const deadline = dateLikeToLocalDate(quotedDeadlineAt);
  const sent = dateLikeToLocalDate(sentAt);
  if (!deadline || !sent) return false;
  return deadline.getTime() - sent.getTime() >= minRemainingMs;
}

function autoConfirmDecision(row, now) {
  row = row || {};
  if (row.state !== 'AWAIT_TENANT' || row.awaiting !== 'tenant') {
    return { action: 'skip', reason: 'not_awaiting_tenant' };
  }
  if (row.policy_explicit_confirm) {
    return { action: 'skip', reason: 'explicit_confirmation_required' };
  }
  if (!row.tenant_notified_at) {
    // Manual relay mode creates the tenant notice as a draft. If staff never
    // approve it, the tenant was never told anything. Auto-confirming off a
    // draft would send a viewer to a flat whose occupant has no idea.
    return { action: 'skip', reason: 'notice_not_sent' };
  }
  if (row.auto_confirmed_at) {
    return { action: 'skip', reason: 'already_confirmed' };
  }
  if (!row.opt_out_deadline_at) {
    return { action: 'skip', reason: 'no_deadline' };
  }
  const deadline = dateLikeToLocalDate(row.opt_out_deadline_at);
  const nowDate = dateLikeToLocalDate(now);
  if (!deadline || !nowDate) return { action: 'skip', reason: 'no_deadline' };
  if (nowDate.getTime() < deadline.getTime()) {
    return { action: 'wait', reason: 'before_deadline' };
  }
  return { action: 'auto_confirm', reason: 'window_elapsed' };
}

// How long a tenant on the explicit-YES path may stay silent before one nudge.
// See the comment at its use site for why this is a constant here rather than
// borrowed from tenant_opt_out_hours.
const TENANT_EXPLICIT_NUDGE_HOURS = 4;

function positiveHours(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function draftQueryOptions(query = {}) {
  const party = ['prospect', 'tenant'].includes(query.party) ? query.party : null;
  const parsedHours = Number(query.max_age_hours);
  const requestedHours = Number.isFinite(parsedHours) && parsedHours > 0
    ? Math.min(parsedHours, 8760)
    : 1;
  return {
    limit: clampedInteger(query.limit, 50, 1, 200),
    // max_age_hours may only NARROW the window, never widen it. Honouring a
    // caller's max_age_hours=168 would reinstate exactly the week-old drafts the
    // freshness rule exists to remove, via a parameter they already send.
    maxAgeMinutes: Math.max(1, Math.floor(Math.min(requestedHours * 60, DRAFT_FRESH_MINUTES))),
    party,
  };
}

function chooseTenantNoticeTemplate(policy, deadline) {
  if (policy && policy.require_explicit_confirmation) {
    return { templateType: 'Viewing-Tenant-Explicit', eventType: 'tenant_explicit_confirm_request', deadline: null };
  }
  return { templateType: 'Viewing-Tenant-Ask', eventType: 'tenant_silence_confirm', deadline: null };
}

// What should we say to this party RIGHT NOW, given only the conversation's
// current state? Deliberately separate from nextStep, which interprets an inbound
// reply — this answers the question when nothing new has arrived.
// null means there is nothing appropriate to send. An unknown state returns null
// rather than guessing a template: a wrong message to a real customer is worse
// than no message, and NEEDS_STAFF already has a human on it.
function composeStep({ state, awaiting, hasCandidates, hasPendingUnit, policy, deadline } = {}) {
  const party = awaiting === 'prospect' || awaiting === 'tenant' ? awaiting : null;
  if (!party) return null;
  if (state === 'RESOLVE_UNIT' && party === 'prospect') {
    return { templateType: hasCandidates ? 'Viewing-Choose-Unit' : 'Viewing-Unit-NotFound', party };
  }
  if (state === 'CONFIRM_UNIT' && party === 'prospect') {
    return hasPendingUnit ? { templateType: 'Viewing-Confirm-Unit', party } : null;
  }
  if (state === 'ASK_PROSPECT_DAY' && party === 'prospect') {
    return { templateType: 'Viewing-Prospect-Day-Ask', party };
  }
  if (state === 'CONFIRM_TIME' && party === 'prospect') {
    return { templateType: 'Viewing-Confirm-Time', party };
  }
  if (state === 'RELAY_TO_PROSPECT' && party === 'prospect') {
    return { templateType: 'Viewing-Relay-Prospect', party };
  }
  if (state === 'AWAIT_TENANT' && party === 'tenant') {
    return { ...chooseTenantNoticeTemplate(policy, deadline), party };
  }
  if (state === 'ASK_TENANT_ALT' && party === 'tenant') {
    return { templateType: 'Viewing-Tenant-Alt-Ask', party };
  }
  return null;
}

function nudgeDecision(row, setting, now) {
  row = row || {};
  setting = { ...DEFAULT_SETTING, ...(setting || {}) };
  const party = row.awaiting;
  if (party !== 'prospect' && party !== 'tenant') {
    return { action: 'none', party: null, nudgeNumber: null, reason: 'not_awaiting_party' };
  }

  const nowDate = dateLikeToLocalDate(now);
  const lastNudgeAt = dateLikeToLocalDate(row.last_nudge_at);
  // The anti-double-send guard exists to stop a slow hourly tick sending the same
  // nudge twice. It must NOT hold back an `escalate`: a negotiation that has blown
  // past its timeout belongs on a human's desk now, and suppressing that because we
  // happened to nudge 20 minutes ago would leave it stranded for another hour.
  // So it is applied at the END, to `nudge` decisions only.
  const nudgedRecently = Boolean(nowDate && lastNudgeAt
    && nowDate.getTime() - lastNudgeAt.getTime() < 3600000);
  const guard = (decision) => (decision.action === 'nudge' && nudgedRecently
    ? { action: 'none', party, nudgeNumber: null, reason: 'nudged_recently' }
    : decision);

  if (party === 'prospect') {
    const askedAt = dateLikeToLocalDate(row.customer_asked_at);
    if (!askedAt || !nowDate) return { action: 'none', party, nudgeNumber: null, reason: 'anchor_missing' };
    const idle = (nowDate.getTime() - askedAt.getTime()) / 3600000;
    const count = Number(row.customer_nudge_count) || 0;
    const cap = Math.max(0, Number(setting.customer_nudge_cap) || 0);
    if (idle >= positiveHours(setting.customer_timeout_hours, DEFAULT_SETTING.customer_timeout_hours)) {
      return { action: 'escalate', party, nudgeNumber: null, reason: 'customer_timeout' };
    }
    if (count >= cap) {
      return { action: 'none', party, nudgeNumber: null, reason: 'nudge_cap_reached' };
    }
    if (count === 0 && idle >= positiveHours(setting.customer_nudge_1_hours, DEFAULT_SETTING.customer_nudge_1_hours)) {
      return guard({ action: 'nudge', party, nudgeNumber: 1, reason: 'customer_nudge_1_due' });
    }
    if (count === 1 && idle >= positiveHours(setting.customer_nudge_2_hours, DEFAULT_SETTING.customer_nudge_2_hours)) {
      return guard({ action: 'nudge', party, nudgeNumber: 2, reason: 'customer_nudge_2_due' });
    }
    return { action: 'none', party, nudgeNumber: null, reason: 'not_due' };
  }

  const notifiedAt = dateLikeToLocalDate(row.tenant_notified_at);
  if (!notifiedAt || !nowDate) return { action: 'none', party, nudgeNumber: null, reason: 'anchor_missing' };
  if (!row.policy_explicit_confirm) {
    // On the auto-confirm path, silence is a valid expected answer. Nudges only
    // belong on the explicit-YES path.
    return { action: 'none', party, nudgeNumber: null, reason: 'opt_out_path_no_nudge' };
  }
  const idle = (nowDate.getTime() - notifiedAt.getTime()) / 3600000;
  const count = Number(row.tenant_nudge_count) || 0;
  const cap = Math.max(0, Number(setting.tenant_nudge_cap) || 0);
  const timeout = positiveHours(setting.tenant_explicit_timeout_hours, DEFAULT_SETTING.tenant_explicit_timeout_hours);
  if (idle >= timeout) {
    return { action: 'escalate', party, nudgeNumber: null, reason: 'tenant_timeout' };
  }
  // Deliberately NOT read from tenant_opt_out_hours. The response window is a
  // different concept that does not apply on this path, and borrowing it couples two
  // settings destructively: widening the auto-confirm window to 24h to give tenants more
  // room would push this nudge out to the 24h escalation, so the tenant would never
  // be nudged at all. Instead: 4h by default (a viewing that sits unanswered longer
  // than that is already costing the booking), capped at half the timeout so the
  // nudge always lands before escalation however the operator tunes it.
  const nudgeAt = Math.max(1, Math.min(TENANT_EXPLICIT_NUDGE_HOURS, timeout / 2));
  if (count < cap && idle >= nudgeAt) {
    return guard({ action: 'nudge', party, nudgeNumber: count + 1, reason: 'tenant_nudge_due' });
  }
  if (count >= cap) return { action: 'none', party, nudgeNumber: null, reason: 'nudge_cap_reached' };
  return { action: 'none', party, nudgeNumber: null, reason: 'not_due' };
}

function reversalClassification({ state, party, intent } = {}) {
  if (state !== STATE_AUTO_CONFIRMED && state !== 'CONFIRMED') return null;
  if (party === 'prospect') return null;
  if (party !== 'tenant') return null;
  intent = intent || {};
  if (intent.cancel || intent.accepted === false) {
    return { state: STATE_TENANT_REVERSED, reason: 'tenant_declined_after_auto_confirm' };
  }
  if (intent.when) {
    return { state: STATE_RESCHEDULE_AFTER_COMMIT, reason: 'tenant_countered_after_auto_confirm' };
  }
  return { state: 'NEEDS_STAFF', reason: 'tenant_reply_after_confirm' };
}

function sendModeFor(eventType, setting) {
  const autoAllowed = new Set(['customer_nudge', 'tenant_nudge', 'staff_alert']);
  // Fail closed by construction: anything that commits, changes or cancels a
  // viewing must never be auto-sent, so an unrecognised event type is approved by
  // staff unless it is explicitly allowlisted and enabled.
  if (autoAllowed.has(eventType) && setting && setting.auto_send_nudges) return 'auto';
  return 'approve';
}

function idempotencyKeyFor(negotiationId, eventType, seq) {
  if (negotiationId == null || negotiationId === '') throw new TypeError('negotiationId is required');
  if (!eventType) throw new TypeError('eventType is required');
  return `${negotiationId}:${eventType}:${seq}`;
}

function withinQuietHours(whenIso, setting) {
  setting = setting || DEFAULT_SETTING;
  const m = String(whenIso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return true;
  const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 0=Sun
  const days = String(setting.viewing_days || DEFAULT_SETTING.viewing_days)
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  if (!days.includes(dow)) return true;
  const minute = +m[4] * 60 + +m[5];
  return minute < minutesOf(setting.viewing_start) || minute >= minutesOf(setting.viewing_end);
}

/**
 * PURE transition core. Decides the next step given state + party + normalized
 * intent. Calendar-gated steps return { type:'staff_check', ... } for the
 * orchestrator (viewingNegotiation.js) to resolve against the roster/calendar.
 *
 * intent (normalized): { when?:ISO|null, accepted?:bool, cancel?:bool, currentWhen?:ISO }
 * roundCount escalates BEFORE incrementing: once roundCount >= maxRounds, the
 * next counter-offer escalates to staff (so up to maxRounds counters happen).
 */
// When `readBack` is on, a fresh time PROPOSAL returns { type:'read_back', ... }
// instead of acting immediately — the orchestrator echoes the parsed time+unit to
// the proposer and moves to CONFIRM_TIME. On confirmation, `nextStep` returns
// { type:'confirmed_proceed', proposedBy, ... } and the orchestrator runs the
// deferred action (staff_check for a prospect time, relay for a tenant counter).
// `proposedBy` is the negotiation's stored proposer (only meaningful in CONFIRM_TIME).
function nextStep({ state, party, intent, roundCount, maxRounds, readBack = false, proposedBy = null }) {
  intent = intent || {};
  if (intent.cancel) return { type: 'cancel' };

  if (party === 'prospect') {
    // Unit resolution phase (before the day-ask). The orchestrator does the actual
    // DB-backed matching; nextStep only interprets the prospect's reply. A picked
    // list item / a confirmed single match / a fresh name all route back to it.
    if (state === 'CONFIRM_UNIT') {
      // Single match awaiting a YES: confirm, or a fresh name re-resolves. There is
      // NO candidate list here, so a bare number/"no"/anything-else just re-asks
      // (routing it to unit_picked would index an empty list).
      if (intent.accepted === true) return { type: 'unit_confirmed' };
      if (intent.unit_text) return { type: 'resolve_unit', text: intent.unit_text };
      return { type: 'reask_unit' };
    }
    if (state === 'RESOLVE_UNIT') {
      if (intent.index != null || intent.choice) return { type: 'unit_picked', index: intent.index, choice: intent.choice };
      if (intent.unit_text) return { type: 'resolve_unit', text: intent.unit_text };
      return { type: 'ignore' };
    }
    if (state === 'ASK_PROSPECT_DAY') {
      if (!intent.when) return { type: 'reprompt_day' };
      if (readBack) return { type: 'read_back', when: intent.when, proposedBy: 'prospect', roundDelta: 0 };
      return { type: 'staff_check', when: intent.when, proposedBy: 'prospect', confirmOnFree: false, roundDelta: 0 };
    }
    if (state === 'RELAY_TO_PROSPECT') {
      if (intent.accepted === true) {
        return { type: 'staff_check', when: intent.currentWhen, proposedBy: 'tenant', confirmOnFree: true, roundDelta: 0 };
      }
      if (intent.when) {
        if (roundCount >= maxRounds) return { type: 'escalate', reason: 'max_rounds' };
        if (readBack) return { type: 'read_back', when: intent.when, proposedBy: 'prospect', roundDelta: 1 };
        return { type: 'staff_check', when: intent.when, proposedBy: 'prospect', confirmOnFree: false, roundDelta: 1 };
      }
      return { type: 'reprompt_day' }; // declined without a counter
    }
    // The occupant reversed an already-confirmed viewing and offered another time,
    // which we relayed to the customer. Accepting it confirms IMMEDIATELY with
    // confirmOnFree — the tenant proposed this slot themselves, so re-opening a
    // second tenant response window would ask them to consent to their own suggestion.
    // Anything other than a clean yes goes to staff: this booking has already been
    // promised and broken once, so restarting the relay loop is the wrong instinct.
    if (state === STATE_RESCHEDULE_AFTER_COMMIT) {
      if (intent.accepted === true) {
        return { type: 'staff_check', when: intent.currentWhen, proposedBy: 'tenant', confirmOnFree: true, roundDelta: 0 };
      }
      return { type: 'escalate', reason: 'reschedule_declined_after_commit' };
    }
    if (state === 'CONFIRM_TIME') {
      if (proposedBy !== 'prospect') return { type: 'ignore' }; // only the proposer confirms their own time
      if (intent.when) return { type: 'read_back', when: intent.when, proposedBy: 'prospect', roundDelta: 0 }; // corrected → re-confirm
      if (intent.accepted === true) return { type: 'confirmed_proceed', proposedBy: 'prospect', when: intent.pendingWhen };
      return { type: 'reprompt_day' }; // "no" → ask for another time
    }
    return { type: 'ignore' };
  }

  if (party === 'tenant') {
    if (state === 'AWAIT_TENANT' || state === 'ASK_TENANT_ALT') {
      if (state === 'AWAIT_TENANT' && intent.accepted === true) return { type: 'confirm' };
      if (intent.when) {
        if (roundCount >= maxRounds) return { type: 'escalate', reason: 'max_rounds' };
        if (readBack) return { type: 'read_back', when: intent.when, proposedBy: 'tenant', roundDelta: 1 };
        return { type: 'relay_to_prospect', when: intent.when, proposedBy: 'tenant', roundDelta: 1 };
      }
      if (state === 'AWAIT_TENANT') return { type: 'ask_tenant_alt' }; // declined, no time yet
      return { type: 'ignore' };
    }
    if (state === 'CONFIRM_TIME') {
      if (proposedBy !== 'tenant') return { type: 'ignore' };
      if (intent.when) return { type: 'read_back', when: intent.when, proposedBy: 'tenant', roundDelta: 0 };
      if (intent.accepted === true) return { type: 'confirmed_proceed', proposedBy: 'tenant', when: intent.pendingWhen };
      return { type: 'ask_tenant_alt' }; // "no" → ask the tenant for another time
    }
    return { type: 'ignore' };
  }
  return { type: 'ignore' };
}

// Routing block TaneChat pre-seeds its local phone→negotiation map from, so it
// can avoid a per-message /active call. `negRow` needs prospect_phone + awaiting;
// tenantPhone is looked up by the caller.
function buildRouting(negRow, tenantPhone) {
  const prospectPhone = (negRow && negRow.prospect_phone) || null;
  const parties = { prospect: { phone: prospectPhone }, tenant: { phone: tenantPhone || null } };
  const awaiting = (negRow && negRow.awaiting) || null;
  const awaiting_phone = awaiting === 'prospect' ? prospectPhone
    : awaiting === 'tenant' ? (tenantPhone || null) : null;
  return { parties, awaiting_phone };
}

// Defaults mirror VIEWING_REMINDER_HOURS / VIEWING_STALE_HOURS in viewingNegotiation.js.
// Callers there pass the configured values explicitly; these are only for tests and
// any caller that genuinely wants the stock cadence.
function reminderTarget(row, { reminderHours = 4, staleHours = 24 } = {}) {
  if (!row || row.reminder_sent_at) return null;
  if (!['prospect', 'tenant'].includes(row.awaiting)) return null;
  const hoursIdle = Number(row.hoursIdle);
  if (!Number.isFinite(hoursIdle)) return null;
  if (hoursIdle < Number(reminderHours)) return null;
  if (hoursIdle >= Number(staleHours)) return null;
  return row.awaiting;
}

function activeNegotiationPayload(rows, targetDigits) {
  const matches = [];
  for (const r of rows || []) {
    // A booked-but-not-yet-happened viewing is routable for the TENANT only. They can
    // still withdraw, and that reversal has to reach us. The prospect cannot reopen a
    // booked viewing by messaging — handleReply refuses a prospect reply on a terminal
    // state, so marking it routable would have TaneChat relay a message that is then
    // dropped, and the viewer would get silence instead of "we'll follow up".
    const committed = r.state === 'CONFIRMED' || r.state === STATE_AUTO_CONFIRMED;
    if (r.prospect_digits === targetDigits) {
      const routable = r.state !== 'NEEDS_STAFF' && !committed;
      matches.push({ negotiation_id: String(r.id), party: 'prospect', state: r.state,
        needs_staff_reason: r.needs_staff_reason || null, awaiting: r.awaiting, routable });
    }
    if (r.tenant_digits && r.tenant_digits === targetDigits) {
      const routable = r.state !== 'NEEDS_STAFF';
      matches.push({ negotiation_id: String(r.id), party: 'tenant', state: r.state,
        needs_staff_reason: r.needs_staff_reason || null, awaiting: r.awaiting, routable });
    }
  }
  matches.sort((a, b) => {
    if (a.routable !== b.routable) return a.routable ? -1 : 1;
    return (b.awaiting === b.party ? 1 : 0) - (a.awaiting === a.party ? 1 : 0);
  });
  return { active: matches.some(m => m.routable), negotiations: matches };
}

module.exports = {
  DEFAULT_SETTING, STATE_AUTO_CONFIRMED, STATE_TENANT_REVERSED, STATE_RESCHEDULE_AFTER_COMMIT,
  TERMINAL_STATES, CLOSED_STATES, DRAFT_FRESH_MINUTES,
  combineDateTime, minutesOf, withinWindow, withinQuietHours, viewingWindow, marketabilityDecision,
  isResumableHold, RESUMABLE_HOLD_REASONS, nextStep, buildRouting,
  resolvePolicy, optOutDeadline, noticeIsActionable, autoConfirmDecision, nudgeDecision,
  reversalClassification,
  sendModeFor, idempotencyKeyFor, reminderTarget, activeNegotiationPayload, draftQueryOptions,
  orgWallClock, toOrgWallClock, ORG_TIME_ZONE,
  chooseTenantNoticeTemplate, composeStep,
};

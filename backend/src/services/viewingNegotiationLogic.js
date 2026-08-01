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
};

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

// Returns null if `whenIso` is within the org viewing window, else an error string.
function withinWindow(whenIso, setting) {
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
  if (new Date(whenIso).getTime() < Date.now()) return 'In the past';
  return null;
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

module.exports = { DEFAULT_SETTING, combineDateTime, minutesOf, withinWindow, viewingWindow, nextStep, buildRouting };

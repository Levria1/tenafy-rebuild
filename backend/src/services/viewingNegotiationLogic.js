/**
 * Pure logic for the Viewing Relay Scheduler state machine.
 *
 * NO heavy/side-effecting imports (no googleapis, no DB) so it loads instantly
 * and is unit-testable in isolation. services/viewingNegotiation.js re-exports
 * everything here and adds the async orchestration (DB, calendar, sending).
 */

const DEFAULT_SETTING = {
  relay_mode: 'manual', max_rounds: 3,
  viewing_days: '1,2,3,4,5,6', viewing_start: '11:00:00', viewing_end: '19:00:00',
};

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
function nextStep({ state, party, intent, roundCount, maxRounds }) {
  intent = intent || {};
  if (intent.cancel) return { type: 'cancel' };

  if (party === 'prospect') {
    if (state === 'ASK_PROSPECT_DAY') {
      if (!intent.when) return { type: 'reprompt_day' };
      return { type: 'staff_check', when: intent.when, proposedBy: 'prospect', confirmOnFree: false, roundDelta: 0 };
    }
    if (state === 'RELAY_TO_PROSPECT') {
      if (intent.accepted === true) {
        return { type: 'staff_check', when: intent.currentWhen, proposedBy: 'tenant', confirmOnFree: true, roundDelta: 0 };
      }
      if (intent.when) {
        if (roundCount >= maxRounds) return { type: 'escalate', reason: 'max_rounds' };
        return { type: 'staff_check', when: intent.when, proposedBy: 'prospect', confirmOnFree: false, roundDelta: 1 };
      }
      return { type: 'reprompt_day' }; // declined without a counter
    }
    return { type: 'ignore' };
  }

  if (party === 'tenant') {
    if (state === 'AWAIT_TENANT' || state === 'ASK_TENANT_ALT') {
      if (state === 'AWAIT_TENANT' && intent.accepted === true) return { type: 'confirm' };
      if (intent.when) {
        if (roundCount >= maxRounds) return { type: 'escalate', reason: 'max_rounds' };
        return { type: 'relay_to_prospect', when: intent.when, proposedBy: 'tenant', roundDelta: 1 };
      }
      if (state === 'AWAIT_TENANT') return { type: 'ask_tenant_alt' }; // declined, no time yet
      return { type: 'ignore' };
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

module.exports = { DEFAULT_SETTING, combineDateTime, minutesOf, withinWindow, nextStep, buildRouting };

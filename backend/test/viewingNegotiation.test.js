const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_SETTING, combineDateTime, minutesOf, withinWindow, viewingWindow, nextStep, buildRouting,
} = require('../src/services/viewingNegotiationLogic');

// A fixed far-future weekday base so "in the past" never trips these tests.
// 2099-01-06 is a Tuesday; 2099-01-04 is a Sunday.
const S = DEFAULT_SETTING;

test('combineDateTime: accepts date+time, datetime, when; rejects junk', () => {
  assert.equal(combineDateTime({ date: '2099-01-06', time: '17:00' }), '2099-01-06T17:00:00');
  assert.equal(combineDateTime({ datetime: '2099-01-06T09:30' }), '2099-01-06T09:30:00');
  assert.equal(combineDateTime({ when: '2099-01-06 9:05' }), '2099-01-06T09:05:00'); // pads hour, space sep
  assert.equal(combineDateTime({}), null);
  assert.equal(combineDateTime(null), null);
  assert.equal(combineDateTime({ date: 'tomorrow' }), null);
});

test('minutesOf: HH:mm → minutes', () => {
  assert.equal(minutesOf('11:00:00'), 660);
  assert.equal(minutesOf('19:00'), 1140);
  assert.equal(minutesOf(''), 0);
});

test('withinWindow: enforces days + open/close + not-in-past', () => {
  assert.equal(withinWindow('2099-01-06T17:00:00', S), null);              // Tue 5pm OK
  assert.equal(withinWindow('2099-01-06T09:00:00', S), 'Before opening time');
  assert.equal(withinWindow('2099-01-06T18:45:00', S), 'After closing time'); // 18:45+30 > 19:00
  assert.equal(withinWindow('2099-01-04T12:00:00', S), 'Outside viewing days'); // Sunday
  assert.equal(withinWindow('2000-01-04T12:00:00', S), 'In the past');
  assert.equal(withinWindow('not-a-date', S), 'Invalid date/time');
});

test('withinWindow: custom viewing_days honoured (Sunday-only org)', () => {
  const sunOnly = { ...S, viewing_days: '0' };
  assert.equal(withinWindow('2099-01-04T12:00:00', sunOnly), null);       // Sunday allowed
  assert.equal(withinWindow('2099-01-06T12:00:00', sunOnly), 'Outside viewing days'); // Tuesday not
});

// ── nextStep transitions ─────────────────────────────────────────────────────
const NS = (state, party, intent, roundCount = 0, maxRounds = 3) =>
  nextStep({ state, party, intent, roundCount, maxRounds });

test('nextStep: prospect proposes a day → staff_check', () => {
  assert.deepEqual(
    NS('ASK_PROSPECT_DAY', 'prospect', { when: '2099-01-06T17:00:00' }),
    { type: 'staff_check', when: '2099-01-06T17:00:00', proposedBy: 'prospect', confirmOnFree: false, roundDelta: 0 }
  );
});

test('nextStep: unparseable prospect day → reprompt', () => {
  assert.deepEqual(NS('ASK_PROSPECT_DAY', 'prospect', { when: null }), { type: 'reprompt_day' });
});

test('nextStep: tenant accepts → confirm', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'tenant', { accepted: true }), { type: 'confirm' });
});

test('nextStep: tenant counters → relay to prospect (round++)', () => {
  assert.deepEqual(
    NS('AWAIT_TENANT', 'tenant', { accepted: false, when: '2099-01-07T15:00:00' }),
    { type: 'relay_to_prospect', when: '2099-01-07T15:00:00', proposedBy: 'tenant', roundDelta: 1 }
  );
});

test('nextStep: tenant declines with no time → ask for alternative', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'tenant', { accepted: false }), { type: 'ask_tenant_alt' });
});

test('nextStep: tenant gives alternative in ASK_TENANT_ALT → relay', () => {
  assert.deepEqual(
    NS('ASK_TENANT_ALT', 'tenant', { when: '2099-01-07T15:00:00' }),
    { type: 'relay_to_prospect', when: '2099-01-07T15:00:00', proposedBy: 'tenant', roundDelta: 1 }
  );
});

test('nextStep: prospect accepts relayed time → staff_check with confirmOnFree', () => {
  assert.deepEqual(
    NS('RELAY_TO_PROSPECT', 'prospect', { accepted: true, currentWhen: '2099-01-07T15:00:00' }, 1),
    { type: 'staff_check', when: '2099-01-07T15:00:00', proposedBy: 'tenant', confirmOnFree: true, roundDelta: 0 }
  );
});

test('nextStep: prospect counters the relay → staff_check (round++)', () => {
  assert.deepEqual(
    NS('RELAY_TO_PROSPECT', 'prospect', { accepted: false, when: '2099-01-08T16:00:00' }, 1),
    { type: 'staff_check', when: '2099-01-08T16:00:00', proposedBy: 'prospect', confirmOnFree: false, roundDelta: 1 }
  );
});

test('nextStep: escalates once roundCount reaches maxRounds', () => {
  // tenant side
  assert.deepEqual(
    NS('AWAIT_TENANT', 'tenant', { accepted: false, when: '2099-01-07T15:00:00' }, 3, 3),
    { type: 'escalate', reason: 'max_rounds' }
  );
  // prospect side
  assert.deepEqual(
    NS('RELAY_TO_PROSPECT', 'prospect', { accepted: false, when: '2099-01-08T16:00:00' }, 3, 3),
    { type: 'escalate', reason: 'max_rounds' }
  );
});

test('nextStep: cancel from either side → cancel', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'tenant', { cancel: true }), { type: 'cancel' });
  assert.deepEqual(NS('ASK_PROSPECT_DAY', 'prospect', { cancel: true }), { type: 'cancel' });
});

test('nextStep: replies in the wrong state are ignored, not acted on', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'prospect', { when: '2099-01-06T17:00:00' }), { type: 'ignore' });
  assert.deepEqual(NS('ASK_PROSPECT_DAY', 'tenant', { accepted: true }), { type: 'ignore' });
  assert.deepEqual(NS('CONFIRMED', 'tenant', { accepted: true }), { type: 'ignore' });
});

test('nextStep: prospect declines relay without a counter → reprompt for a day', () => {
  assert.deepEqual(NS('RELAY_TO_PROSPECT', 'prospect', { accepted: false }), { type: 'reprompt_day' });
});

// ── read-back reconfirmation ──────────────────────────────────────────────────
test('read-back ON: prospect propose → read_back (not straight to staff_check)', () => {
  assert.deepEqual(
    nextStep({ state: 'ASK_PROSPECT_DAY', party: 'prospect', intent: { when: '2099-01-06T17:00:00' }, roundCount: 0, maxRounds: 3, readBack: true }),
    { type: 'read_back', when: '2099-01-06T17:00:00', proposedBy: 'prospect', roundDelta: 0 }
  );
});

test('read-back OFF: prospect propose → staff_check (unchanged)', () => {
  assert.deepEqual(
    nextStep({ state: 'ASK_PROSPECT_DAY', party: 'prospect', intent: { when: '2099-01-06T17:00:00' }, roundCount: 0, maxRounds: 3, readBack: false }),
    { type: 'staff_check', when: '2099-01-06T17:00:00', proposedBy: 'prospect', confirmOnFree: false, roundDelta: 0 }
  );
});

test('read-back ON: tenant counter → read_back (roundDelta 1)', () => {
  assert.deepEqual(
    nextStep({ state: 'AWAIT_TENANT', party: 'tenant', intent: { accepted: false, when: '2099-01-07T15:00:00' }, roundCount: 0, maxRounds: 3, readBack: true }),
    { type: 'read_back', when: '2099-01-07T15:00:00', proposedBy: 'tenant', roundDelta: 1 }
  );
});

test('CONFIRM_TIME + yes (prospect) → confirmed_proceed with the pending time', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'prospect', intent: { accepted: true, pendingWhen: '2099-01-06T17:00:00' }, roundCount: 0, maxRounds: 3, proposedBy: 'prospect' }),
    { type: 'confirmed_proceed', proposedBy: 'prospect', when: '2099-01-06T17:00:00' }
  );
});

test('CONFIRM_TIME + yes (tenant) → confirmed_proceed (tenant)', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'tenant', intent: { accepted: true, pendingWhen: '2099-01-07T15:00:00' }, roundCount: 0, maxRounds: 3, proposedBy: 'tenant' }),
    { type: 'confirmed_proceed', proposedBy: 'tenant', when: '2099-01-07T15:00:00' }
  );
});

test('CONFIRM_TIME + corrected time → re-read_back (no round bump)', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'prospect', intent: { when: '2099-01-08T16:00:00' }, roundCount: 1, maxRounds: 3, proposedBy: 'prospect' }),
    { type: 'read_back', when: '2099-01-08T16:00:00', proposedBy: 'prospect', roundDelta: 0 }
  );
});

test('CONFIRM_TIME + no → ask again (reprompt for prospect, alt for tenant)', () => {
  assert.deepEqual(nextStep({ state: 'CONFIRM_TIME', party: 'prospect', intent: { accepted: false }, roundCount: 0, maxRounds: 3, proposedBy: 'prospect' }), { type: 'reprompt_day' });
  assert.deepEqual(nextStep({ state: 'CONFIRM_TIME', party: 'tenant', intent: { accepted: false }, roundCount: 0, maxRounds: 3, proposedBy: 'tenant' }), { type: 'ask_tenant_alt' });
});

test('CONFIRM_TIME: reply from the WRONG party is ignored', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'tenant', intent: { accepted: true, pendingWhen: 'x' }, roundCount: 0, maxRounds: 3, proposedBy: 'prospect' }),
    { type: 'ignore' }
  );
});

// ── viewingWindow (per-status lead gate) ──────────────────────────────────────
// today 2099-01-06: +45 days = 2099-02-20, +46 = 2099-02-21, +60 = 2099-03-07, +61 = 2099-03-08.
const VW = (endDate, contractType) => viewingWindow({
  endDate, contractType, leadDaysNr: 60, leadDaysOther: 45, today: '2099-01-06',
});

test('viewingWindow: NR (3) uses the 60-day window', () => {
  assert.deepEqual(VW('2099-03-07', 3), { inWindow: true, leadDays: 60, reason: 'ok' });        // exactly +60
  assert.deepEqual(VW('2099-03-08', 3), { inWindow: false, leadDays: 60, reason: 'beyond_window' }); // +61
  assert.equal(VW('2099-02-21', 3).inWindow, true); // +46: inside 60 for NR
});

test('viewingWindow: MTM/MR/UC/unset use the 45-day window', () => {
  for (const ct of [2, 1, 4, 0, null]) {
    assert.deepEqual(VW('2099-02-20', ct), { inWindow: true, leadDays: 45, reason: 'ok' });        // exactly +45
    assert.deepEqual(VW('2099-02-21', ct), { inWindow: false, leadDays: 45, reason: 'beyond_window' }); // +46
  }
});

test('viewingWindow: no end date → out of window (staff decides)', () => {
  assert.deepEqual(VW(null, 3), { inWindow: false, leadDays: 60, reason: 'no_end_date' });
  assert.deepEqual(VW('', 2), { inWindow: false, leadDays: 45, reason: 'no_end_date' });
});

test('viewingWindow: a lease already ended (holdover) is in-window', () => {
  assert.equal(VW('2098-12-01', 2).inWindow, true); // negative daysToEnd
});

test('viewingWindow: well inside the window → in', () => {
  assert.equal(VW('2099-01-20', 0).inWindow, true);
});

// ── buildRouting (TaneChat pre-seed block) ────────────────────────────────────
test('buildRouting: awaiting prospect → awaiting_phone is the prospect phone', () => {
  const r = buildRouting({ prospect_phone: '+85261234567', awaiting: 'prospect' }, '+85269998888');
  assert.deepEqual(r.parties, { prospect: { phone: '+85261234567' }, tenant: { phone: '+85269998888' } });
  assert.equal(r.awaiting_phone, '+85261234567');
});

test('buildRouting: awaiting tenant → awaiting_phone is the tenant phone', () => {
  const r = buildRouting({ prospect_phone: '+85261234567', awaiting: 'tenant' }, '+85269998888');
  assert.equal(r.awaiting_phone, '+85269998888');
});

test('buildRouting: vacant unit (no tenant phone) → tenant phone null, no crash', () => {
  const r = buildRouting({ prospect_phone: '+85261234567', awaiting: 'staff' }, null);
  assert.equal(r.parties.tenant.phone, null);
  assert.equal(r.awaiting_phone, null); // awaiting=staff → nobody to route to
});

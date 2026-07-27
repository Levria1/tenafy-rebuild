const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_SETTING, combineDateTime, minutesOf, withinWindow, nextStep, buildRouting,
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

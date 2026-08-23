/**
 * The check-in send window.
 *
 * This logic had no test at all until now, which mattered because it is date
 * arithmetic spanning two clocks: the send fires on a cron pinned to Hong Kong,
 * the dates come out of a MySQL server running UTC, and the machine running the
 * process may be either. Every case below pins fixed calendar dates so it holds
 * wherever the suite runs — and the suite runs under both TZ=UTC and
 * TZ=Asia/Hong_Kong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toCalendarDate,
  daysUntilStart,
  normaliseLeadDays,
  isWithinCheckinWindow,
  bitToBool,
  shouldSendCheckinNow,
  shouldSendCheckinFollowUp,
} = require('../src/utils/checkinWindow');

// ---------------------------------------------------------------------------
// toCalendarDate
// ---------------------------------------------------------------------------

test('toCalendarDate reads a MySQL DATE back as the day the database stored', () => {
  // mysql2 builds DATE columns with `new Date(y, m, d)` — LOCAL midnight. Reading
  // it back with the UTC getters would give 2026-08-13 anywhere east of Greenwich,
  // which is the operator's whole timezone.
  assert.equal(toCalendarDate(new Date(2026, 7, 14)), '2026-08-14');
  assert.equal(toCalendarDate(new Date(2026, 0, 1)), '2026-01-01');
});

test('toCalendarDate takes the date part of a string and does not re-anchor it', () => {
  assert.equal(toCalendarDate('2026-08-14'), '2026-08-14');
  assert.equal(toCalendarDate('2026-08-14T00:00:00.000Z'), '2026-08-14');
});

test('toCalendarDate returns null rather than a wrong date', () => {
  for (const bad of [null, undefined, '', 'next tuesday', new Date('nonsense')]) {
    assert.equal(toCalendarDate(bad), null);
  }
});

// ---------------------------------------------------------------------------
// daysUntilStart
// ---------------------------------------------------------------------------

test('daysUntilStart counts whole calendar days in both directions', () => {
  assert.equal(daysUntilStart('2026-08-14', '2026-08-07'), 7);
  assert.equal(daysUntilStart('2026-08-14', '2026-08-14'), 0);
  assert.equal(daysUntilStart('2026-08-14', '2026-08-15'), -1);
});

test('daysUntilStart crosses a month and a year boundary correctly', () => {
  assert.equal(daysUntilStart('2026-09-01', '2026-08-25'), 7);
  assert.equal(daysUntilStart('2027-01-04', '2026-12-28'), 7);
});

test('daysUntilStart is unaffected by DST in the host timezone', () => {
  // Date.UTC anchoring is the point of dayNumber(). A naive
  // (a - b) / 86400000 over a spring-forward boundary in a DST zone yields 6.958
  // days, which rounds correctly by luck and not by design.
  assert.equal(daysUntilStart('2026-03-15', '2026-03-08'), 7);
  assert.equal(daysUntilStart('2026-11-08', '2026-11-01'), 7);
});

test('daysUntilStart rejects a date that does not exist', () => {
  // Date.UTC silently rolls 30 February forward to 2 March.
  assert.equal(daysUntilStart('2026-02-30', '2026-02-01'), null);
  assert.equal(daysUntilStart('2026-02-28', '2026-02-01'), 27);
});

// ---------------------------------------------------------------------------
// normaliseLeadDays — an unconfigured template must not become an infinite window
// ---------------------------------------------------------------------------

test('normaliseLeadDays treats missing or nonsense config as no lead time', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, -5]) {
    assert.equal(normaliseLeadDays(bad), 0);
  }
  assert.equal(normaliseLeadDays('14'), 14);
  assert.equal(normaliseLeadDays(14), 14);
});

// ---------------------------------------------------------------------------
// isWithinCheckinWindow
// ---------------------------------------------------------------------------

test('isWithinCheckinWindow: 14-day lead opens exactly 14 days out', () => {
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-07-31', 14), true);   // start-14
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-07-30', 14), false);  // start-15
});

test('isWithinCheckinWindow: the lead time is a floor, not an exact day', () => {
  // The whole reason the sweep uses >= rather than ==: a lease created at start-3
  // never existed at start-14, and must still get its email.
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-11', 14), true);
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-14', 14), true);   // same-day move-in
});

test('isWithinCheckinWindow: a lease that has already started never sends', () => {
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-15', 14), false);
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-09-01', 14), false);
});

test('isWithinCheckinWindow: a zero lead means the start date only', () => {
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-13', 0), false);
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-14', 0), true);
});

test('isWithinCheckinWindow: the 7 -> 14 change opens the window a week earlier', () => {
  // Straight from the operator's question: today 7 Aug, tenant moves in 14 Aug.
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-07', 7), true);
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-07', 14), true);
  // And the day the two settings actually differ.
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-04', 7), false);
  assert.equal(isWithinCheckinWindow('2026-08-14', '2026-08-04', 14), true);
});

test('isWithinCheckinWindow: an unreadable date sends nothing rather than everything', () => {
  assert.equal(isWithinCheckinWindow(null, '2026-08-07', 14), false);
  assert.equal(isWithinCheckinWindow('2026-08-14', null, 14), false);
});

// ---------------------------------------------------------------------------
// bitToBool — tenant_checkin is a bit(1)
// ---------------------------------------------------------------------------

test('bitToBool decodes a mysql2 bit(1) Buffer', () => {
  // The trap: Boolean(Buffer.from([0])) is TRUE. Reading tenant_checkin with a
  // plain truthiness check mails every tenant whose toggle is off.
  assert.equal(bitToBool(Buffer.from([0])), false);
  assert.equal(bitToBool(Buffer.from([1])), true);
});

test('bitToBool handles the shapes the request body and the driver produce', () => {
  assert.equal(bitToBool(true), true);
  assert.equal(bitToBool(1), true);
  assert.equal(bitToBool('1'), true);
  assert.equal(bitToBool(false), false);
  assert.equal(bitToBool(0), false);
  assert.equal(bitToBool('0'), false);
  assert.equal(bitToBool(null), false);
  assert.equal(bitToBool(undefined), false);
});

// ---------------------------------------------------------------------------
// shouldSendCheckinNow — every gate, and the reason it refused
// ---------------------------------------------------------------------------

const base = {
  leaseState: 'active',
  tenantCheckin: 1,
  startDate: '2026-08-14',
  today: '2026-08-07',
  leadDays: 14,
};

test('shouldSendCheckinNow sends for a confirmed lease inside the window', () => {
  assert.deepEqual(shouldSendCheckinNow(base), { send: true, reason: 'in_window' });
});

test('shouldSendCheckinNow refuses a pending lease, and says so', () => {
  // This is the gate that makes the confirm endpoint necessary. The nightly sweep
  // filters `lease_state = 'active'` in SQL; before this the create endpoint did
  // not, so an unconfirmed lease got check-in instructions the sweep would never
  // have sent.
  assert.deepEqual(
    shouldSendCheckinNow({ ...base, leaseState: 'pending' }),
    { send: false, reason: 'lease_not_active' }
  );
});

test('shouldSendCheckinNow respects the per-lease toggle over everything else', () => {
  assert.deepEqual(
    shouldSendCheckinNow({ ...base, tenantCheckin: Buffer.from([0]) }),
    { send: false, reason: 'checkin_disabled' }
  );
});

test('shouldSendCheckinNow distinguishes "no start date" from "too far out"', () => {
  assert.deepEqual(
    shouldSendCheckinNow({ ...base, startDate: null }),
    { send: false, reason: 'no_start_date' }
  );
  assert.deepEqual(
    shouldSendCheckinNow({ ...base, today: '2026-07-01' }),
    { send: false, reason: 'outside_window' }
  );
});

test('shouldSendCheckinNow refuses a backdated lease', () => {
  // Two live leases are in this state. Check-in instructions arriving after
  // move-in are worse than none, so both paths agree on refusing.
  assert.deepEqual(
    shouldSendCheckinNow({ ...base, today: '2026-08-20' }),
    { send: false, reason: 'already_started' }
  );
});

test('shouldSendCheckinNow refuses when the caller did not say what state the lease is in', () => {
  // This assertion was the OTHER WAY ROUND in the first version of this file, and
  // was changed deliberately after review, not to make a failing test pass.
  //
  // The original reasoning was that both call sites know the state, so an absent
  // one could be trusted as active. That is fail-OPEN: a future refactor that drops
  // `leaseState` from a call site reinstates the pending-lease bug this function
  // exists to close, and every test here would still be green. Refusing instead
  // costs at most one night — the 07:00 sweep picks the lease up regardless — and
  // an email about a tenancy that never happened cannot be unsent.
  assert.deepEqual(
    shouldSendCheckinNow({ ...base, leaseState: undefined }),
    { send: false, reason: 'lease_not_active' }
  );
});

test('shouldSendCheckinNow: the toggle is checked before the state', () => {
  // Reason ordering is load-bearing for the logs: a lease that is both pending and
  // has check-in switched off should report the setting staff can see, not the
  // internal state machine.
  assert.equal(
    shouldSendCheckinNow({ ...base, leaseState: 'pending', tenantCheckin: 0 }).reason,
    'checkin_disabled'
  );
});

// ---------------------------------------------------------------------------
// shouldSendCheckinFollowUp — the second nudge (`date_second` on the template)
// ---------------------------------------------------------------------------

// The live configuration as of 23 Aug 2026: first email 14 days out, follow-up 3.
const followUp = {
  leaseState: 'active',
  tenantCheckin: 1,
  startDate: '2026-09-01',
  followUpDays: 3,
  firstSentOn: '2026-08-18',   // start-14, i.e. the first leg fired on time
};

test('follow-up: fires on the configured day once the first email has aged', () => {
  assert.deepEqual(
    shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-29' }),   // start-3
    { send: true, reason: 'follow_up_due' }
  );
});

test('follow-up: does not fire before its own window opens', () => {
  assert.equal(shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-28' }).reason, 'outside_window');
});

test('follow-up: a sweep that misses its day still catches up', () => {
  // Deliberately a window and not an exact-day match. An exact DATEDIFF === 3
  // would skip the nudge in silence if the 07:00 run failed that one morning.
  assert.equal(shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-31' }).send, true);
});

test('follow-up: never fires when the first email never went', () => {
  // A "follow-up" to nothing is just a late first email, and leg one's own window
  // is what decides that. Sending here would also mean the tenant's FIRST contact
  // is a reminder about details they were never given.
  assert.deepEqual(
    shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-29', firstSentOn: null }),
    { send: false, reason: 'first_email_not_sent' }
  );
});

test('follow-up: no follow-up when the whole booking happened inside the gap', () => {
  // Lease keyed in two days before move-in: leg one fires immediately, and a
  // near-identical email the next morning is noise, not a reminder. "14 then 3"
  // asks for a nudge after a gap; there was no gap.
  assert.deepEqual(
    shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-31', firstSentOn: '2026-08-30' }),
    { send: false, reason: 'no_gap_to_follow_up' }
  );
});

test('follow-up: the boundary of that rule is exactly the follow-up lead', () => {
  // First email sent AT start-3 — the same day the follow-up would be due. No gap.
  assert.equal(
    shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-29', firstSentOn: '2026-08-29' }).reason,
    'no_gap_to_follow_up'
  );
  // First email one day earlier — a real, if short, gap.
  assert.equal(
    shouldSendCheckinFollowUp({ ...followUp, today: '2026-08-29', firstSentOn: '2026-08-28' }).send,
    true
  );
});

test('follow-up: an unconfigured second email is off, not "same day as the first"', () => {
  // date_second is 0/NULL for every other org's Check-In template. Falling through
  // to normaliseLeadDays' zero would make the follow-up due on the start date
  // itself and mail everyone a duplicate.
  for (const off of [0, null, undefined, '']) {
    assert.deepEqual(
      shouldSendCheckinFollowUp({ ...followUp, today: '2026-09-01', followUpDays: off }),
      { send: false, reason: 'no_follow_up_configured' }
    );
  }
});

test('follow-up: inherits every gate the first email has', () => {
  const at = { ...followUp, today: '2026-08-29' };
  assert.equal(shouldSendCheckinFollowUp({ ...at, tenantCheckin: Buffer.from([0]) }).reason, 'checkin_disabled');
  assert.equal(shouldSendCheckinFollowUp({ ...at, leaseState: 'pending' }).reason, 'lease_not_active');
  assert.equal(shouldSendCheckinFollowUp({ ...at, startDate: null }).reason, 'no_start_date');
  assert.equal(shouldSendCheckinFollowUp({ ...at, today: '2026-09-02' }).reason, 'already_started');
});

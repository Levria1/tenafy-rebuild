const test = require('node:test');
const assert = require('node:assert/strict');

const {
  orgWallClock, withinQuietHours, withinWindow, resolvePolicy,
} = require('../src/services/viewingNegotiationLogic');
const { outboundSendDecision } = require('../src/services/viewingNegotiation');

// Production runs UTC; the operator is in Hong Kong (UTC+8) and both configures
// viewing hours and receives prospect times as HK wall clock. Every case below
// uses a fixed Z-suffixed instant so the assertions hold wherever the suite runs —
// the developer machine is itself in HKT, which would otherwise make a broken
// implementation pass for the wrong reason.
const HOURS = { viewing_days: '1,2,3,4,5,6', viewing_start: '11:00:00', viewing_end: '19:00:00' };

test('orgWallClock converts a UTC instant to the operator wall clock', () => {
  assert.equal(orgWallClock(new Date('2026-08-16T06:00:00Z')), '2026-08-16T14:00:00');
});

test('orgWallClock crosses the date boundary — 16:00 UTC is already tomorrow in Hong Kong', () => {
  // The off-by-one-day case: any check that derives a DATE from the server clock
  // is on the wrong day for eight hours out of every twenty-four.
  assert.equal(orgWallClock(new Date('2026-08-16T16:30:00Z')), '2026-08-17T00:30:00');
});

test('orgWallClock returns null for an unparseable instant rather than a fake time', () => {
  assert.equal(orgWallClock(new Date('nonsense')), null);
});

test('quiet hours are ACTIVE at 23:56 Hong Kong, the case measured on production', () => {
  // 15:56 UTC. Read off the server clock this is 15:56, inside 11:00-19:00, so the
  // bot considered itself open and would have messaged a tenant at midnight.
  assert.equal(withinQuietHours(orgWallClock(new Date('2026-08-14T15:56:00Z')), HOURS), true);
});

test('quiet hours are NOT active during the Hong Kong working day', () => {
  // Friday 14:00 HK. The mirror of the case above: an offset applied in the wrong
  // direction would suppress every message during business hours instead.
  assert.equal(withinQuietHours(orgWallClock(new Date('2026-08-14T06:00:00Z')), HOURS), false);
});

test('short notice fires for a viewing one hour away', () => {
  // THE SAFETY REGRESSION. viewingStartAt is operator wall clock; passing the raw
  // instant as noticeSentAt compares a UTC clock with an HK one and inflates the
  // gap by 8 hours, so a viewing 1 hour away reads as 9 and silence would confirm
  // a viewing the tenant has had no real chance to object to.
  // Deliberately the raw Date a caller actually passes, not a pre-converted one.
  const policy = resolvePolicy({
    setting: { tenant_opt_out_hours: 4 },
    viewingStartAt: '2026-08-16T15:00:00',
    noticeSentAt: new Date('2026-08-16T06:00:00Z'),
  });

  assert.equal(policy.require_explicit_confirmation, true);
  assert.equal(policy.source, 'short_notice');
});

test('short notice does NOT fire for a viewing genuinely beyond the window', () => {
  // Guards the opposite failure: over-correcting would force an explicit yes on
  // every viewing and quietly disable silence-confirms.
  const policy = resolvePolicy({
    setting: { tenant_opt_out_hours: 4 },
    viewingStartAt: '2026-08-17T15:00:00',
    noticeSentAt: new Date('2026-08-16T06:00:00Z'),
  });

  assert.equal(policy.require_explicit_confirmation, false);
});

test('withinWindow rejects a time already past on the operator clock', () => {
  // Fri 2026-08-14, 14:00 Hong Kong. A 12:00 slot that day has passed by two
  // hours. Read off a UTC server the same digits look like 12:00 UTC — four hours
  // in the FUTURE — so the guard would wave through a viewing nobody can attend.
  const nowHk = orgWallClock(new Date('2026-08-14T06:00:00Z'));

  assert.equal(withinWindow('2026-08-14T12:00:00', HOURS, nowHk), 'In the past');
});

test('withinWindow still accepts a slot later the same operator day', () => {
  // The mirror: 17:00 on that same Friday is still ahead and inside 11:00-19:00.
  const nowHk = orgWallClock(new Date('2026-08-14T06:00:00Z'));

  assert.equal(withinWindow('2026-08-14T17:00:00', HOURS, nowHk), null);
});

test('the quiet-hours CALL SITE derives now from the operator clock', () => {
  // outboundSendDecision is where quiet hours are actually consulted. Reading the
  // server clock here is what would have messaged a tenant at 23:56 Hong Kong.
  const setting = { ...HOURS, auto_send_nudges: 1, respect_quiet_hours: 1, relay_mode: 'auto' };
  const lateHk = new Date('2026-08-14T15:56:00Z');   // 23:56 Friday, Hong Kong
  const middayHk = new Date('2026-08-14T06:00:00Z'); // 14:00 Friday, Hong Kong

  assert.equal(outboundSendDecision('customer_nudge', setting, lateHk).shouldSend, false);
  assert.equal(outboundSendDecision('customer_nudge', setting, middayHk).shouldSend, true);
});

test('withinWindow DEFAULTS to the operator clock, not the server clock', () => {
  // The bug is only visible inside the 8-hour band where a UTC reading of an HK
  // time still looks like the future, so probe a moment a few hours BEHIND the
  // operator clock. An all-hours window keeps the other gates out of the way; the
  // offset search keeps the probe away from midnight so no date edge interferes.
  const ALL_HOURS = { viewing_days: '0,1,2,3,4,5,6', viewing_start: '00:00:00', viewing_end: '23:59:00' };
  let probed = false;

  for (const hoursBack of [2, 3, 4, 5, 6, 7]) {
    const when = orgWallClock(new Date(Date.now() - hoursBack * 3600 * 1000));
    const hour = Number(when.slice(11, 13));
    if (hour < 1 || hour > 22) continue;
    probed = true;
    // Already past on the operator clock. Read off a UTC server it is still hours
    // in the future, so a viewing nobody can attend would be accepted.
    assert.equal(withinWindow(when, ALL_HOURS), 'In the past',
      `withinWindow accepted ${when}, which has already passed in ${orgWallClock().slice(11, 16)} operator time`);
    break;
  }

  assert.ok(probed, 'no testable probe time was found');
});

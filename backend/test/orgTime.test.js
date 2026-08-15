const test = require('node:test');
const assert = require('node:assert/strict');

const { orgWallClock, orgToday, orgTodayDate, toOrgWallClock } = require('../src/utils/orgTime');

// Production runs Etc/UTC; the operator, tenants and TaneChat are all UTC+8. The
// dev machine is itself HKT, so a broken implementation passes there for the wrong
// reason — every case below pins a fixed Z-suffixed instant so the assertions hold
// wherever the suite runs, and CI must run it under BOTH TZ=UTC and TZ=Asia/Hong_Kong.

test('orgToday returns the Hong Kong calendar date, not the server one', () => {
  // 16:05 UTC is 00:05 the NEXT day in Hong Kong. This is exactly the slot the
  // markOverdue job now fires in, and the reason moving cron to HK time without
  // also fixing CURDATE() would have been a regression: `due_on < CURDATE()`
  // would have compared against yesterday and marked invoices overdue a day late.
  assert.equal(orgToday(new Date('2026-08-15T16:05:00Z')), '2026-08-16');
});

test('orgToday agrees with UTC during the band where the two dates coincide', () => {
  // 02:00 UTC = 10:00 HK, same calendar day. Before this change every date-math
  // job happened to fire inside this band, which is why the bug was invisible.
  assert.equal(orgToday(new Date('2026-08-16T02:00:00Z')), '2026-08-16');
});

test('orgToday rolls over at Hong Kong midnight, not UTC midnight', () => {
  // One minute either side of 16:00 UTC.
  assert.equal(orgToday(new Date('2026-08-15T15:59:00Z')), '2026-08-15');
  assert.equal(orgToday(new Date('2026-08-15T16:01:00Z')), '2026-08-16');
});

test('orgTodayDate anchors at UTC midnight so day arithmetic lines up', () => {
  // scheduler.js compares `today` against dates built the same way
  // (`new Date(toDateString(dbDate))`). Both sides must come through a
  // 'YYYY-MM-DD' string or the anchors differ by the local offset and every
  // daysDiff is off by one for part of the day.
  const d = orgTodayDate(new Date('2026-08-15T16:05:00Z'));

  assert.equal(d.toISOString(), '2026-08-16T00:00:00.000Z');
});

test('orgTodayDate stays comparable with a date parsed from a YYYY-MM-DD string', () => {
  const today = orgTodayDate(new Date('2026-08-16T02:00:00Z'));
  const sameDay = new Date('2026-08-16');
  const nextDay = new Date('2026-08-17');

  assert.equal(today.getTime(), sameDay.getTime());
  assert.equal(Math.round((nextDay - today) / 86400000), 1);
});

test('orgWallClock converts a UTC instant to the operator wall clock', () => {
  assert.equal(orgWallClock(new Date('2026-08-16T06:00:00Z')), '2026-08-16T14:00:00');
});

test('orgWallClock returns null for an unparseable instant rather than a fake time', () => {
  assert.equal(orgWallClock(new Date('nonsense')), null);
  assert.equal(orgToday(new Date('nonsense')), null);
  assert.equal(orgTodayDate(new Date('nonsense')), null);
});

test('toOrgWallClock passes an already-wall-clock string through untouched', () => {
  // Double-shifting a value that is already operator time is the mistake that
  // broke a quiet-hours test under TZ=UTC while passing under HKT.
  assert.equal(toOrgWallClock('2026-08-16T14:00:00'), '2026-08-16T14:00:00');
  assert.equal(toOrgWallClock(new Date('2026-08-16T06:00:00Z')), '2026-08-16T14:00:00');
});

test('the zone is IANA, so the offset is not hardcoded', () => {
  // A fixed +480 gives the same numbers today but silently rots the first time
  // this runs for an org anywhere else.
  assert.equal(orgWallClock(new Date('2026-08-16T06:00:00Z'), 'UTC'), '2026-08-16T06:00:00');
  assert.equal(orgWallClock(new Date('2026-08-16T06:00:00Z'), 'America/New_York'), '2026-08-16T02:00:00');
});

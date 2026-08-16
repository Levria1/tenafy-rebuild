const test = require('node:test');
const assert = require('node:assert/strict');

const { orgToday, orgTodaySql, sqlDateLiteral, dbDate } = require('../src/utils/orgTime');

// 16:05 UTC on the 15th is already 00:05 on the 16th in Hong Kong. Every test
// below uses this instant, because it is the only kind that tells the two zones
// apart — anything between 00:00 and 15:59 UTC agrees in both and would pass with
// the bug still in place.
const STRADDLE = new Date('2026-08-15T16:05:00Z');

test('orgTodaySql quotes the Hong Kong date, not the UTC one', () => {
  assert.equal(STRADDLE.toISOString().slice(0, 10), '2026-08-15', 'sanity: UTC is still the 15th');
  assert.equal(orgTodaySql(STRADDLE), "'2026-08-16'");
});

test('orgTodaySql output is a bare quoted date — nothing else can get in', () => {
  // The whole safety argument for inlining rather than binding is that this value
  // cannot carry anything but digits and dashes. Pin it.
  assert.match(orgTodaySql(STRADDLE), /^'\d{4}-\d{2}-\d{2}'$/);
});

test('orgTodaySql throws rather than emit SQL it cannot vouch for', () => {
  // A malformed date must never be interpolated into a query. Failing loudly is
  // the point: silently emitting '' or NULL would turn a clock problem into a
  // wrong-results problem.
  assert.throws(() => orgTodaySql(new Date('not a date')), /malformed/i);
});

test('sqlDateLiteral rejects a well-shaped but impossible date', () => {
  // The regex alone would wave 2026-02-30 through. Shape is not validity, and the
  // whole point of this helper is that nothing reaches the query text unchecked.
  assert.throws(() => sqlDateLiteral('2026-02-30'), /malformed/i);
  assert.throws(() => sqlDateLiteral('2026-13-01'), /malformed/i);
  assert.equal(sqlDateLiteral('2026-02-28'), "'2026-02-28'");
  assert.equal(sqlDateLiteral('2028-02-29'), "'2028-02-29'", 'a real leap day must pass');
});

test('dbDate reads a DATE column the way mysql2 hands it over', () => {
  // mysql2 parses a DATE into new Date(y, m-1, d) — LOCAL midnight. toISOString()
  // on that shifts it to the previous day anywhere east of UTC, which is exactly
  // the off-by-one this helper exists to prevent.
  const asMysql2Returns = new Date(2026, 7, 16); // local midnight, 16 Aug 2026
  assert.equal(dbDate(asMysql2Returns), '2026-08-16');
});

test('dbDate passes through a string date unchanged', () => {
  assert.equal(dbDate('2026-08-16'), '2026-08-16');
  assert.equal(dbDate('2026-08-16T00:00:00.000Z'), '2026-08-16');
});

test('dbDate returns null for empty and unparseable values', () => {
  assert.equal(dbDate(null), null);
  assert.equal(dbDate(undefined), null);
  assert.equal(dbDate(''), null);
  assert.equal(dbDate(new Date('nope')), null);
  assert.equal(dbDate('not-a-date'), null);
});

test('dbDate and orgToday are not interchangeable', () => {
  // Guards against someone "simplifying" one into the other. dbDate reads a stored
  // value in the process zone; orgToday asks what day it is in Hong Kong. They
  // answer different questions and only coincide by accident.
  const stored = new Date(2026, 7, 15); // local midnight, 15 Aug
  assert.equal(dbDate(stored), '2026-08-15');
  assert.equal(orgToday(STRADDLE), '2026-08-16');
});

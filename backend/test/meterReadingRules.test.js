/**
 * The reading rules, tested for behaviour rather than by matching handler text.
 *
 * GPT's review of 6399619 made a fair point: the tests around this work asserted
 * the SHAPE of the code, so they would pass on a regression that moved the same
 * mistake somewhere else. The decisions worth trusting — what counts as a valid
 * date, what counts as a usable reading, what counts as a correction — are pure,
 * so they belong in a module that can be called and checked.
 *
 * Two live defects it also found, both fixed and pinned here: 'abc' became NaN,
 * compared unequal to everything, and was sent to a DECIMAL(12,2) column; and a
 * full ISO timestamp went straight into a DATE column, where strict mode may
 * reject it and where the UTC day can differ from the org's day.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  READING_TYPE_CORRECTION, normaliseReadingDate, parseReadingValue, isCorrection,
} = require('../src/utils/meterReading');

const TODAY = '2026-09-07';

// ── dates ───────────────────────────────────────────────────────────────────

test('a plain date passes through', () => {
  assert.strictEqual(normaliseReadingDate('2026-08-23', TODAY), '2026-08-23');
});

test('an absent date becomes the org\'s today', () => {
  assert.strictEqual(normaliseReadingDate(undefined, TODAY), TODAY);
  assert.strictEqual(normaliseReadingDate(null, TODAY), TODAY);
  assert.strictEqual(normaliseReadingDate('', TODAY), TODAY);
  assert.strictEqual(normaliseReadingDate('   ', TODAY), TODAY);
});

test('an ISO timestamp is reduced to its date part', () => {
  // reading_date is a DATE column. Passing the whole timestamp risks rejection in
  // strict mode, and its UTC day is not necessarily the org's day.
  assert.strictEqual(normaliseReadingDate('2026-08-23T23:30:00.000Z', TODAY), '2026-08-23');
  assert.strictEqual(normaliseReadingDate('2026-08-23 14:05:00', TODAY), '2026-08-23');
});

test('nonsense is rejected rather than handed to MySQL', () => {
  for (const bad of ['abc', '23/08/2026', '2026-8-3', '20260823', 'yesterday', '2026-02-30', '2026-13-01']) {
    assert.strictEqual(normaliseReadingDate(bad, TODAY), null, `${bad} should be refused`);
  }
});

test('a Date object is accepted, an invalid one is not', () => {
  assert.strictEqual(normaliseReadingDate(new Date(2026, 7, 23), TODAY), '2026-08-23');
  assert.strictEqual(normaliseReadingDate(new Date('nope'), TODAY), null);
});

// ── values ──────────────────────────────────────────────────────────────────

test('a usable reading is returned as a number', () => {
  assert.strictEqual(parseReadingValue('23241'), 23241);
  assert.strictEqual(parseReadingValue(23241.5), 23241.5);
  assert.strictEqual(parseReadingValue('0'), 0);
  assert.strictEqual(parseReadingValue(0), 0);
});

test('an unusable reading returns null instead of NaN', () => {
  // The bug: Number('abc') is NaN, NaN !== anything is true, so it read as a
  // correction and went to the database.
  for (const bad of ['abc', 'NaN', {}, [1, 2], Infinity, -Infinity, -1, '-5']) {
    assert.strictEqual(parseReadingValue(bad), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test('an omitted reading is null, which is not a correction', () => {
  assert.strictEqual(parseReadingValue(undefined), null);
  assert.strictEqual(parseReadingValue(null), null);
  assert.strictEqual(parseReadingValue(''), null);
});

// ── what counts as a correction ─────────────────────────────────────────────

test('a different value is a correction', () => {
  assert.strictEqual(isCorrection(23241, 23134), true);
  assert.strictEqual(isCorrection(23241, 23241.5), true);
});

test('the same value is not', () => {
  assert.strictEqual(isCorrection(23241, 23241), false);
  // The form sends a number; the column arrives as a decimal string.
  assert.strictEqual(isCorrection('23241.00', 23241), false);
});

test('omitting the field is never a correction', () => {
  // Saving an unrelated edit must not write a correction row.
  assert.strictEqual(isCorrection(23241, null), false);
  assert.strictEqual(isCorrection(23241, parseReadingValue(undefined)), false);
});

test('correcting to zero is still a correction', () => {
  // A falsy-but-real value. Treating 0 as "not provided" would make a genuine
  // reset impossible.
  assert.strictEqual(isCorrection(23241, 0), true);
  assert.strictEqual(parseReadingValue(0), 0);
});

test('the correction reading type is 4 and does not collide', () => {
  // 0 Move-In, 1 Move-Out, 2 Billing, 3 Monthly are already in use on live data.
  assert.strictEqual(READING_TYPE_CORRECTION, 4);
  assert.ok(![0, 1, 2, 3].includes(READING_TYPE_CORRECTION));
});

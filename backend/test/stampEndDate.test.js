const test = require('node:test');
const assert = require('node:assert');
const { defaultStampEndDate, effectiveStampEndDate } = require('../src/services/leaseTemplateVariables');

// The stamped term convention: 2 years MINUS 1 day from the lease start, so the
// stamped period is exactly two years inclusive.
test('stamp default: 2 years minus 1 day (the user example)', () => {
  assert.equal(defaultStampEndDate('2026-08-20'), '2028-08-19');
});

test('stamp default: start of month rolls back to the previous month', () => {
  assert.equal(defaultStampEndDate('2026-01-01'), '2027-12-31');
});

test('stamp default: leap-day start clamps like dayjs/MySQL', () => {
  // 2024-02-29 +2y CLAMPS to 2026-02-28 (no Feb 29 in 2026), then -1d = 2026-02-27.
  // Must match the create-form prefill (dayjs .add(2,'year') also clamps), so the
  // stored value and the computed fallback can never disagree.
  assert.equal(defaultStampEndDate('2024-02-29'), '2026-02-27');
});

test('stamp default: accepts a Date and a datetime string', () => {
  assert.equal(defaultStampEndDate(new Date(2026, 7, 20)), '2028-08-19');
  assert.equal(defaultStampEndDate('2026-08-20T00:00:00.000Z'), '2028-08-19');
});

test('stamp default: missing/invalid input yields empty string', () => {
  assert.equal(defaultStampEndDate(null), '');
  assert.equal(defaultStampEndDate(''), '');
  assert.equal(defaultStampEndDate('not-a-date'), '');
});

test('effective: stored stamp date wins over the computed default', () => {
  assert.equal(
    effectiveStampEndDate({ start_date: '2026-08-20', stamp_end_date: '2029-01-31' }),
    '2029-01-31'
  );
});

test('effective: falls back to the default when no stamp date is stored', () => {
  assert.equal(effectiveStampEndDate({ start_date: '2026-08-20' }), '2028-08-19');
  assert.equal(effectiveStampEndDate({ start_date: '2026-08-20', stamp_end_date: null }), '2028-08-19');
});

test('effective: a stored Date is read as wall-clock (no TZ day shift)', () => {
  // mysql2 returns a DATE column as a LOCAL-midnight Date.
  assert.equal(
    effectiveStampEndDate({ start_date: '2026-08-20', stamp_end_date: new Date(2028, 7, 19) }),
    '2028-08-19'
  );
});

test('effective: no lease / no dates yields empty string', () => {
  assert.equal(effectiveStampEndDate(null), '');
  assert.equal(effectiveStampEndDate({}), '');
});

const test = require('node:test');
const assert = require('node:assert');
const { isMovedOutEarly } = require('../src/routes/leasing');

test('move-out: earlier date is early', () => {
  assert.equal(isMovedOutEarly('2026-08-15', '2026-08-31'), true);
});

test('move-out: same date is not early', () => {
  assert.equal(isMovedOutEarly('2026-08-31', '2026-08-31'), false);
});

test('move-out: later date is not early', () => {
  assert.equal(isMovedOutEarly('2026-09-01', '2026-08-31'), false);
});

test('move-out: null original end date is not early', () => {
  assert.equal(isMovedOutEarly('2026-08-15', null), false);
  assert.equal(isMovedOutEarly('2026-08-15', undefined), false);
});

test('move-out: accepts string move-out and Date original end inputs', () => {
  assert.equal(isMovedOutEarly('2026-08-15', new Date(2026, 7, 31, 18, 30)), true);
});

test('move-out: accepts Date move-out and string original end inputs', () => {
  assert.equal(isMovedOutEarly(new Date(2026, 7, 31, 23, 59), '2026-08-31'), false);
});

test('move-out: invalid input is not early', () => {
  assert.equal(isMovedOutEarly('2026-02-30', '2026-08-31'), false);
  assert.equal(isMovedOutEarly('2026-08-15', 'not-a-date'), false);
  assert.equal(isMovedOutEarly(new Date('invalid'), '2026-08-31'), false);
});

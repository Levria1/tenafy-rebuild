const test = require('node:test');
const assert = require('node:assert');
const {
  weekdayOf,
  parseDays,
  formatDays,
  postsOnDay,
  validateDays,
  dayLabel,
} = require('../src/utils/advertisingSchedule');

test('weekdayOf derives UTC weekday from YYYY-MM-DD', () => {
  assert.equal(weekdayOf('2026-08-11'), 2);
  assert.equal(weekdayOf('2026-08-09'), 0);
  assert.equal(weekdayOf('2026-08-15'), 6);
});

test('weekdayOf is timezone-safe', () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Hong_Kong';
    const hk = weekdayOf('2026-08-11');
    process.env.TZ = 'America/Los_Angeles';
    const la = weekdayOf('2026-08-11');
    // A local-parsed date can shift the day and post to the wrong forum.
    assert.equal(hk, 2);
    assert.equal(la, 2);
  } finally {
    process.env.TZ = originalTz;
  }
});

test('weekdayOf rejects malformed dates', () => {
  assert.equal(weekdayOf(''), null);
  assert.equal(weekdayOf('nope'), null);
  assert.equal(weekdayOf('2026-13-40'), null);
  assert.equal(weekdayOf(null), null);
});

test('parseDays sorts, dedupes, and drops junk', () => {
  assert.deepEqual(parseDays('1,2,3'), [1, 2, 3]);
  assert.deepEqual(parseDays('3,1,2,2'), [1, 2, 3]);
  assert.deepEqual(parseDays([1, '2', 3]), [1, 2, 3]);
  assert.deepEqual(parseDays('1,x,9,-1'), [1]);
  assert.deepEqual(parseDays(null), []);
  assert.deepEqual(parseDays(''), []);
});

test('formatDays returns canonical comma string', () => {
  assert.equal(formatDays([3, 1, 2]), '1,2,3');
  assert.equal(formatDays([]), '');
});

test('postsOnDay respects configured weekdays', () => {
  assert.equal(postsOnDay('1,2,3,4,5,6', '2026-08-09'), false);
  assert.equal(postsOnDay('1,2,3,4,5,6', '2026-08-11'), true);
});

test('postsOnDay treats empty configuration as unscheduled', () => {
  // An unconfigured forum must never be treated as "every day"; that is how a
  // group gets posted to on a day it forbids.
  assert.equal(postsOnDay('', '2026-08-11'), false);
  assert.equal(postsOnDay(null, '2026-08-11'), false);
});

test('postsOnDay returns false for malformed dates', () => {
  assert.equal(postsOnDay('1,2,3', 'nope'), false);
});

test('validateDays accepts canonical inputs and rejects invalid ones', () => {
  assert.deepEqual(validateDays([1, 2]), { ok: true, value: '1,2' });
  assert.deepEqual(validateDays('1,2'), { ok: true, value: '1,2' });
  assert.deepEqual(validateDays([]), { ok: true, value: '' });
  assert.deepEqual(validateDays(''), { ok: true, value: '' });
  assert.deepEqual(validateDays([7]), { ok: false, error: 'invalid_post_days' });
  assert.deepEqual(validateDays([-1]), { ok: false, error: 'invalid_post_days' });
  assert.deepEqual(validateDays(['x']), { ok: false, error: 'invalid_post_days' });
  assert.deepEqual(validateDays(5), { ok: false, error: 'invalid_post_days' });
  assert.deepEqual(validateDays({}), { ok: false, error: 'invalid_post_days' });
});

test('dayLabel returns short weekday names', () => {
  assert.equal(dayLabel(1), 'Mon');
  assert.equal(dayLabel(9), '');
});

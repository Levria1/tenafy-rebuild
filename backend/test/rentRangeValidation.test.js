const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rentRangeError } = require('../src/routes/property');

// ---------------------------------------------------------------------------
// min <= max on write.
//
// A real unit was saved with the floor 1,000 ABOVE the ceiling and the error
// reached a partner's quoting path before anyone noticed. Worth being precise
// about what went wrong, because the obvious diagnosis is wrong: the posting
// ladder is order-safe — computePostingRent takes min()/max() of the two bounds,
// so the step-down never inverted. What happened instead is that "top of range"
// resolved to the typo'd floor, and a rate above the intended ceiling was
// published. Order-safety downstream is not the same as correct data.
//
// The guard is deliberately narrow. It rejects a definite contradiction and
// nothing else; anything wider starts refusing legitimate saves, and a
// validation that blocks real work gets worked around.
// ---------------------------------------------------------------------------

test('rejects a reversed range — the case that actually happened', () => {
  // Tai Yuen 26/F as it was stored: floor 19,000, ceiling 18,000.
  const err = rentRangeError(19000, 18000);
  assert.ok(err, 'a reversed range must not save');
  assert.match(err, /19000/);
  assert.match(err, /18000/);
});

test('accepts a correct range — the positive control', () => {
  // Without this the guard could reject everything and every other assertion
  // here would still pass.
  assert.equal(rentRangeError(18000, 20000), null);
  assert.equal(rentRangeError(11800, 12500), null);
});

test('accepts equal bounds — a fixed price is not a contradiction', () => {
  assert.equal(rentRangeError(12000, 12000), null);
});

test('accepts a partial range — a floor with no ceiling must keep saving', () => {
  // Most units in the portfolio predate rent_price_max. Rejecting these would
  // break ordinary editing of every one of them.
  assert.equal(rentRangeError(12000, null), null);
  assert.equal(rentRangeError(null, 12000), null);
  assert.equal(rentRangeError(null, null), null);
  assert.equal(rentRangeError(undefined, undefined), null);
});

test('treats empty strings as absent, not as zero', () => {
  // An untouched form field arrives as ''. Number('') is 0, which would make
  // ('' , 5000) look like a valid 0..5000 range and (12000, '') look reversed —
  // the second would block a legitimate save with a nonsense message.
  assert.equal(rentRangeError('', ''), null);
  assert.equal(rentRangeError(12000, ''), null);
  assert.equal(rentRangeError('', 12000), null);
});

test('accepts numeric strings, which is how the form actually posts them', () => {
  assert.equal(rentRangeError('18000', '20000'), null);
  assert.ok(rentRangeError('19000', '18000'), 'string comparison must not be used');
  // '9000' > '18000' lexicographically. If this ever compares as text rather
  // than number, this case fails and the reversed case above starts passing.
  assert.equal(rentRangeError('9000', '18000'), null);
});

test('ignores junk rather than blocking the save on it', () => {
  // Non-numeric input is a different problem with a different owner (the column
  // is DECIMAL; MySQL will reject it). This guard answers exactly one question
  // and must not start failing saves for reasons it cannot explain clearly.
  assert.equal(rentRangeError('abc', 5000), null);
  assert.equal(rentRangeError(5000, 'abc'), null);
});

test('the message names both numbers, so the operator can see which way round', () => {
  const err = rentRangeError(19000, 18000);
  assert.match(err, /right way round/i, 'must say what to actually do about it');
});

// --- Tripwire: both write paths call it ------------------------------------
// The guard is worthless on the path that skips it, and there are two: unit
// create and unit update. The update matters most — it sets BOTH bounds
// unconditionally from the request body, so a reversed pair overwrites a good
// stored range.

test('tripwire: both unit write paths call the guard before writing', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/property.js'), 'utf8');
  const calls = src.match(/const rangeError = rentRangeError\(rent_price_min, rent_price_max\);/g) || [];
  assert.equal(calls.length, 2,
    `expected the guard on both unit create and unit update, found ${calls.length}`);
  const returns = src.match(/if \(rangeError\) return res\.status\(400\)/g) || [];
  assert.equal(returns.length, 2, 'each call must actually reject, not just compute a value');
});

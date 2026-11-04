const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renewalAskSettled } = require('../src/utils/renewalAsk');

// Owner, 2026-11-04: "why do we show stuff where the lease ended in the past?" The
// "renewal asks in flight" box listed every ask ever sent; 31 of 36 were settled.

const TODAY = '2026-11-04';
const s = (askedEnd, currentEnd, extra = {}) => renewalAskSettled({ askedEnd, currentEnd, today: TODAY, ...extra });

test('a lease extended after the ask is settled', () => {
  assert.equal(s('2026-10-31', '2026-12-31'), true);
  assert.equal(s('2026-11-18', '2027-02-28'), true);   // future end, but renewed
});

test('a lease whose end has passed is settled', () => {
  assert.equal(s('2026-09-29', '2026-09-29'), true);
  assert.equal(s('2026-09-25', '2026-09-27'), true);   // nudged a few days, then ended
});

test('a lease still running to the asked end, or moved by days, is still open', () => {
  assert.equal(s('2026-11-06', '2026-11-06'), false);
  assert.equal(s('2026-11-18', '2026-11-21'), false);  // move-out moved 3 days: still leaving
  assert.equal(s('2026-11-04', '2026-11-04'), false);  // ends today: not past yet
});

test('a deleted or missing lease is settled; a missing end date is not', () => {
  assert.equal(s('2026-11-06', '2026-11-06', { leaseExists: false }), true);
  assert.equal(s('2026-11-06', null), false);
});

test('the endpoint sends settled and the page leaves settled asks out of the box', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/advertising.js'), 'utf8');
  const at = route.indexOf("router.get('/renewal-asks'");
  const block = route.slice(at, at + 9000);
  assert.match(block, /DATE_FORMAT\(l\.end_date, '%Y-%m-%d'\) AS current_lease_end/);
  assert.match(block, /settled: renewalAsk\.renewalAskSettled\(/);
  const page = fs.readFileSync(path.join(__dirname, '../../frontend/src/app/leasing/vacancy/page.js'), 'utf8');
  assert.match(page, /renewalAsks\.filter\(a => !a\.settled && /);
});

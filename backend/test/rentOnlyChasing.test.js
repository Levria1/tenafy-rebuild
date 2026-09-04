/**
 * Automated chasing is for rent, and only rent.
 *
 * Two decisions live here. First, the weekly sweep had been dead: it filtered
 * `status = 0`, but markOverdueInvoicesForOrg runs at 00:05 and flips every
 * past-due unpaid invoice to 2, so by Monday morning nothing matched. Running
 * its WHERE against production returned 0 rows against 116 without the status
 * filter. Reviving it means widening to IN (0, 2), and a test that pins that is
 * the only thing standing between here and it silently dying again.
 *
 * Second, chasing is scoped to rent. The Overdue template threatens "5% of the
 * monthly rent" per week, which means nothing attached to a HK$305 utility bill
 * or a stamp duty charge. Utilities and deposits are also back-dated by nature,
 * so they collect the badge and the chaser for reasons that have nothing to do
 * with the tenant being slow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isRentCategory } = require('../src/utils/rentCategory');

const scheduler = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'scheduler.js'), 'utf8');
const invoiceRoute = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'invoice.js'), 'utf8');

function overdueJob() {
  const start = scheduler.indexOf('async function sendOverdueRemindersForOrg');
  assert.ok(start > -1, 'sendOverdueRemindersForOrg not found');
  return scheduler.slice(start, scheduler.indexOf('\nasync function', start + 1));
}

// ---------------------------------------------------------------------------
// Category comparison. These ids are Snowflake bigints past MAX_SAFE_INTEGER.
// ---------------------------------------------------------------------------

test('matching ids compare equal across string and number forms', () => {
  assert.equal(isRentCategory('8497095072747520', '8497095072747520'), true);
  assert.equal(isRentCategory(8497095072747520, '8497095072747520'), true);
});

test('a different category never passes as rent', () => {
  // Utilities vs Rental Income, both real ids from org 8300127259922432.
  assert.equal(isRentCategory('8497095072747520', '8300127259922433'), false);
});

test('ids differing only in their last digits do not collide', () => {
  // Comparing as numbers would round these together and let a utility invoice
  // through as rent. See reference_snowflake_id_readback.
  const a = '1788404383048813999';
  const b = '1788404383048813998';
  assert.notEqual(a, b);
  assert.equal(isRentCategory(a, b), false);
  assert.equal(isRentCategory(a, a), true);
});

test('a missing category or a missing rent category is never rent', () => {
  assert.equal(isRentCategory(null, '8497095072747520'), false);
  assert.equal(isRentCategory('8497095072747520', null), false);
  assert.equal(isRentCategory(undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// The weekly sweep
// ---------------------------------------------------------------------------

test('the sweep looks at invoices the nightly job has already flagged', () => {
  const job = overdueJob();
  assert.match(job, /i\.status IN \(0, 2\)/,
    'status = 0 alone matches nothing: markOverdue flips past-due invoices to 2 at 00:05');
  assert.ok(!/WHERE i\.status = 0\b/.test(job),
    'the old status = 0 filter is what made this job send nothing at all');
});

test('rent only is the fallback when no categories are configured', () => {
  const job = overdueJob();
  assert.match(job, /resolveRentCategoryId\(pool, orgId\)/,
    'an org that has never opened the settings screen must still chase rent');
  assert.match(job, /if \(!rentCategoryId\) \{/,
    'an org with neither a category list nor a rent category must bail out ' +
    'rather than fall through to chasing everything');
  assert.match(job, /i\.category IN \(\$\{categoryPlaceholders\}\)/,
    'the query must filter to the resolved list, not merely compute it');
});

test('the sweep still refuses to chase invoices nobody has been sent', () => {
  const job = overdueJob();
  assert.match(job, /chaseableSql\('i\.due_on', 'i\.created_at'/,
    '86 of 2026 rent invoices were created after their own due date, so the grace still matters');
});

test('the sweep binds one parameter per placeholder, in order', () => {
  const job = overdueJob();
  const query = job.match(/const \[invoices\] = await pool\.execute\([\s\S]*?\);/);
  assert.ok(query, 'overdue reminder query not found');
  const binding = query[0].match(/\[([^\]]*)\]\s*\)/);
  assert.ok(binding, 'parameter array not found');
  // DATEDIFF, then the category list, then the two chaseable dates, the repeat
  // date and the lease end date, then the org. Binding these out of order does
  // not throw: it silently compares a date against a category id.
  assert.equal(binding[1].trim(), 'today, ...categoryIds, today, today, today, today, orgId');
});

// ---------------------------------------------------------------------------
// The manual Email button is deliberately NOT category-scoped. A person opening
// one invoice and choosing to chase it is a different act from an unattended
// weekly sweep, and the endpoint must not quietly overrule them.
// ---------------------------------------------------------------------------

test('the Email button can still chase any category', () => {
  const decision = invoiceRoute.match(/const isOverdue = [\s\S]*?\}\);/);
  assert.ok(decision, 'isOverdue assignment not found');
  assert.ok(!/isRent/.test(decision[0]),
    'the manual button must not be scoped to rent; only the automated sweep is');
});

// ---------------------------------------------------------------------------
// The shared lookup must resolve the same row every other call site resolves.
// Picking a different one would make the recurring-invoice job's duplicate
// check miss and create duplicate rent, so drift here is expensive.
// ---------------------------------------------------------------------------

test('the shared helper uses the canonical rent category query', () => {
  const helper = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'rentCategory.js'), 'utf8');
  const canonical =
    "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 AND name LIKE '%Rental Income%' ORDER BY id LIMIT 1";
  assert.ok(helper.includes(canonical),
    "the helper must match the inline copies exactly, including ORDER BY id LIMIT 1; " +
    "'%Rental%' alone also matches 'Rental Expense'");
});

test('the sweep uses the shared helper rather than a fresh inline copy', () => {
  const job = overdueJob();
  assert.ok(!/category_setting/.test(job),
    'the sweep should call resolveRentCategoryId, not inline a tenth copy of the query');
});

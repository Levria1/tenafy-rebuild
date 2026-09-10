/**
 * Two things that reported success and did the wrong thing.
 *
 * 1. `share_lease` is the recurring-invoice flag — the only two places that read
 *    it are the scheduler's lease filter and the confirmation branch in
 *    leasing.js. But BOTH lease forms also carried a checkbox labelled "Share
 *    lease with tenant" bound to the same column, and on the edit page that
 *    checkbox won. So you could switch Recurring Invoice on, save, see it saved,
 *    and have the lease generate nothing. Four active leases were in that state,
 *    two of them already missing a September invoice.
 *
 * 2. The overdue sweep chased any invoice with a cent outstanding. A tenant who
 *    paid HK$17,600 of HK$18,000 got the same demand as one who paid nothing,
 *    and the template threatens "5% of the monthly rent" per week over what is
 *    usually a bank transfer fee.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { loadChaseSettings, numOr, CHASE_DEFAULTS } = require('../src/utils/chaseSettings');

// Line comments FIRST — a "/*" inside one otherwise opens a phantom block comment.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── the thresholds ──────────────────────────────────────────────────────────

test('both thresholds default to zero, so a deploy changes nobody\'s mail', () => {
  assert.strictEqual(CHASE_DEFAULTS.min_outstanding_pct, 0);
  assert.strictEqual(CHASE_DEFAULTS.min_outstanding_amount, 0);
});

test('a percentage is not truncated to a whole number', () => {
  // clamp() would have turned 2.5% into 2%.
  assert.strictEqual(numOr(2.5, 0, 0, 100), 2.5);
  assert.strictEqual(numOr('7.25', 0, 0, 100), 7.25);
});

test('a threshold cannot go negative or past 100%', () => {
  // A negative value read straight from the database would invert the comparison
  // and chase only the people who had nearly paid.
  assert.strictEqual(numOr(-5, 0), 0);
  assert.strictEqual(numOr(150, 0, 0, 100), 100);
  assert.strictEqual(numOr('nonsense', 7), 7);
});

test('a row missing the columns falls back to no threshold, not NaN', async () => {
  const pool = { execute: async () => [[{ enabled: 1, categories: null, days_after_due: 0, days_after_issue: 7, repeat_days: 7 }]] };
  const p = await loadChaseSettings(pool, '1');
  assert.strictEqual(p.min_outstanding_pct, 0);
  assert.strictEqual(p.min_outstanding_amount, 0);
});

test('a missing chase_setting table still yields the OFF defaults', async () => {
  const pool = { execute: async () => { throw new Error("Table 'chase_setting' doesn't exist"); } };
  const p = await loadChaseSettings(pool, '1');
  assert.strictEqual(p.enabled, 0);
  assert.strictEqual(p.min_outstanding_pct, 0);
});

test('loadChaseSettings clamps what it reads from the database', async () => {
  const pool = { execute: async () => [[{
    enabled: 1, categories: null, days_after_due: 0, days_after_issue: 7, repeat_days: 7,
    min_outstanding_pct: '999', min_outstanding_amount: '-40',
  }]] };
  const p = await loadChaseSettings(pool, '1');
  assert.strictEqual(p.min_outstanding_pct, 100);
  assert.strictEqual(p.min_outstanding_amount, 0);
});

// The rule the SQL encodes, asserted as arithmetic so the intent is pinned even
// though the comparison itself runs in MySQL.
const skips = (outstanding, amount, pct, floor) =>
  !((pct === 0 || outstanding >= amount * pct / 100) && (floor === 0 || outstanding >= floor));

test('the worked example from the request', () => {
  // 17,600 paid of 18,000 — a 400 balance is 2.2%, not worth a demand.
  assert.ok(skips(400, 18000, 5, 200), '400 of 18,000 should be skipped at 5%');
  // 15,000 paid of 18,000 — 3,000 is 16.7%, chase it.
  assert.ok(!skips(3000, 18000, 5, 200), '3,000 of 18,000 must still be chased');
});

test('the cash floor catches what a percentage alone misses', () => {
  // 5% of a HK$305 utility bill is HK$15 — a percentage alone would chase HK$16.
  assert.ok(skips(16, 305, 5, 200), 'a 16 balance is below the 200 floor');
  assert.ok(!skips(16, 305, 5, 0), 'without a floor, the percentage alone lets it through');
});

test('zero thresholds preserve the old behaviour exactly', () => {
  assert.ok(!skips(0.09, 17500, 0, 0), 'nine cents is still chased when no threshold is set');
});

test('below EITHER threshold is enough to skip, so raising one chases fewer', () => {
  assert.ok(skips(300, 18000, 5, 0), 'below the percentage alone');
  assert.ok(skips(300, 2000, 0, 500), 'below the floor alone');
  assert.ok(!skips(300, 2000, 5, 200), 'above both');
});

// ── the sweep applies it in SQL, not after the fact ─────────────────────────

const scheduler = stripComments(read('../src/services/scheduler.js'));

test('the thresholds are applied in the query, not in JavaScript afterwards', () => {
  // Every other policy test is in SQL for the same reason: the job looks at 50
  // rows, and a backlog of ineligible invoices must not crowd out the late ones.
  const sweep = scheduler.slice(scheduler.indexOf('async function sendOverdueRemindersForOrg'));
  assert.match(sweep, /AND \(\? = 0 OR outstanding >= i\.amount \* \? \/ 100\)/);
  assert.match(sweep, /AND \(\? = 0 OR outstanding >= \?\)/);
  assert.match(sweep, /policy\.min_outstanding_pct, policy\.min_outstanding_pct/);
  assert.match(sweep, /policy\.min_outstanding_amount, policy\.min_outstanding_amount/);
});

test('the percentage is of the invoice, never of the outstanding balance', () => {
  // `outstanding >= outstanding * pct/100` would be true for every invoice.
  const sweep = scheduler.slice(scheduler.indexOf('async function sendOverdueRemindersForOrg'));
  assert.doesNotMatch(sweep, /outstanding >= outstanding \*/);
});

test('the settings route saves the thresholds it was sent', () => {
  const settings = stripComments(read('../src/routes/settings.js'));
  // They have to be destructured off the body, or they silently stay at the default.
  assert.match(settings, /min_outstanding_pct,\s*min_outstanding_amount\s*\}\s*=\s*req\.body/);
  assert.match(settings, /min_outstanding_pct = VALUES\(min_outstanding_pct\)/);
  assert.match(settings, /min_outstanding_amount = VALUES\(min_outstanding_amount\)/);
  // numOr, not clamp — clamp truncates and would drop a 2.5% threshold to 2%.
  assert.match(settings, /min_outstanding_pct: numOr\(/);
});

test('the migration adds both columns idempotently', () => {
  const sql = read('../migrations-org/082_chase_minimum_outstanding.sql');
  assert.match(sql, /min_outstanding_pct DECIMAL/);
  assert.match(sql, /min_outstanding_amount DECIMAL/);
  assert.strictEqual((sql.match(/information_schema\.COLUMNS/g) || []).length, 2,
    'each ADD COLUMN must be guarded, or a re-run fails');
  assert.match(sql, /DEFAULT 0/);
});

// ── the recurring flag ──────────────────────────────────────────────────────

test('share_lease is read only as the recurring flag', () => {
  // If something ever does start using it to share a lease with a tenant, this
  // fails and the column needs splitting before the UI can keep pretending.
  const leasing = stripComments(read('../src/routes/leasing.js'));
  const sched = scheduler;
  assert.match(sched, /l\.share_lease = 1/);
  assert.match(leasing, /const isRecurring = lease\.share_lease && lease\.invoicing/);
});

test('the create form has no second control bound to share_lease', () => {
  const page = stripComments(read('../../frontend/src/app/leasing/create/page.js'));
  assert.match(page, /share_lease: makeRecurring \? 1 : 0/);
  assert.doesNotMatch(page, /name="share_lease"/, 'the duplicate checkbox must be gone');
  assert.doesNotMatch(page, /Share lease with tenant/);
});

test('the edit form saves share_lease from the switch, not the old checkbox', () => {
  const page = stripComments(read('../../frontend/src/app/leasing/[id]/edit/page.js'));
  assert.match(page, /share_lease: makeRecurring \? 1 : 0/);
  assert.doesNotMatch(page, /share_lease: !!values\.share_lease/,
    'saving from the checkbox is what made the switch a lie');
  assert.doesNotMatch(page, /name="share_lease"/);
  assert.doesNotMatch(page, /Share lease with tenant/);
});

test('the edit switch reflects both halves of what the scheduler needs', () => {
  // Reading `invoicing` alone showed the switch ON for a lease generating nothing.
  const page = stripComments(read('../../frontend/src/app/leasing/[id]/edit/page.js'));
  assert.match(page, /setMakeRecurring\(!!d\.share_lease && !!d\.invoicing\)/);
});

test('new leases default to recurring', () => {
  const page = stripComments(read('../../frontend/src/app/leasing/create/page.js'));
  assert.match(page, /const \[makeRecurring, setMakeRecurring\] = useState\(true\)/);
});

/**
 * An invoice the tenant has never been sent is not a late payment.
 *
 * The gap this closes: TRIV35264 was a HK$305 utility bill for the meter period
 * 27 July to 26 August, so it carried 26 August as its due date. It could not be
 * created until the meter was read on 3 September, and the very first email the
 * tenant received about it opened "your invoice is currently past due" and
 * closed with a late fee of 5% of monthly rent per week. She was never late.
 *
 * These cover the pure rule. The wiring tests at the bottom check that both
 * senders — the Email button and the Monday sweep — actually consult it, since
 * a correct helper nothing calls fixes nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isChaseable, chaseableSql, CHASE_GRACE_DAYS } = require('../src/utils/overdueChase');

test('the real case: a utility bill is not chased on the day it is created', () => {
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-09-03', today: '2026-09-03',
  }), false);
});

test('the same bill becomes chaseable once the grace period has run', () => {
  // Issued 3 Sep, so the tenant has until 10 Sep. 11 Sep is fair game.
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-09-03', today: '2026-09-10',
  }), false, 'still inside the grace window');
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-09-03', today: '2026-09-11',
  }), true, 'grace has expired');
});

test('an ordinary recurring invoice is unaffected', () => {
  // Raised roughly a month ahead, as the scheduler does. created_at + grace is
  // well before the due date, so the due date remains the only thing that binds.
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-07-28', today: '2026-08-26',
  }), false, 'due today is not overdue');
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-07-28', today: '2026-08-27',
  }), true, 'the day after the due date, exactly as before');
});

test('the grace matches the window the overdue template itself grants', () => {
  // The template says "Rent over 7 days late will result in a penalty fee". The
  // system must stop chasing before the contract starts charging.
  assert.equal(CHASE_GRACE_DAYS, 7);
});

test('an invoice with no due date is never chased', () => {
  assert.equal(isChaseable({
    dueOn: null, createdAt: '2026-01-01', today: '2026-09-11',
  }), false);
});

test('a missing created_at falls back to the old due-date-only rule', () => {
  // created_at is NOT NULL in the schema. If it is ever absent, suppressing a
  // legitimate reminder would be the worse failure.
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: null, today: '2026-08-27',
  }), true);
});

test('Date objects and MySQL DATETIME strings are read the same way', () => {
  const args = { dueOn: '2026-08-26', createdAt: '2026-09-03', today: '2026-09-11' };
  assert.equal(isChaseable(args), true);
  assert.equal(isChaseable({
    dueOn: new Date('2026-08-26T00:00:00Z'),
    createdAt: '2026-09-03 02:59:43',
    today: '2026-09-11',
  }), true, 'a Date and a DATETIME string must agree with the plain strings');
});

test('month and year boundaries do not shift the grace period', () => {
  // Issued 28 Dec, grace runs to 4 Jan.
  assert.equal(isChaseable({
    dueOn: '2026-11-30', createdAt: '2026-12-28', today: '2027-01-04',
  }), false);
  assert.equal(isChaseable({
    dueOn: '2026-11-30', createdAt: '2026-12-28', today: '2027-01-05',
  }), true);
});

test('empty arguments do not throw', () => {
  assert.equal(isChaseable(), false);
  assert.equal(isChaseable({}), false);
});

// ---------------------------------------------------------------------------
// The SQL twin. `created + grace < today` and `created < today - grace` are the
// same statement; the second keeps a bare column on the left for MySQL.
// ---------------------------------------------------------------------------

test('the SQL fragment encodes the same grace constant', () => {
  const sql = chaseableSql('i.due_on', 'i.created_at');
  assert.match(sql, new RegExp(`INTERVAL ${CHASE_GRACE_DAYS} DAY`),
    'the SQL and the JS must not drift apart on the grace period');
  assert.match(sql, /i\.due_on < \?/);
  assert.match(sql, /DATE\(i\.created_at\) < DATE_SUB\(\?, INTERVAL/);
});

test('the SQL fragment declares exactly two placeholders', () => {
  // Both take the org's today. A caller that binds one value too few shifts
  // every later parameter, which throws at runtime rather than at review.
  const sql = chaseableSql('i.due_on', 'i.created_at');
  assert.equal((sql.match(/\?/g) || []).length, 2);
});

// ---------------------------------------------------------------------------
// Wiring: both send paths must consult the rule.
// ---------------------------------------------------------------------------

const invoiceRoute = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'invoice.js'), 'utf8');
const scheduler = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'scheduler.js'), 'utf8');

test('the Email button gates its overdue choice on chaseability', () => {
  const decision = invoiceRoute.match(/const isOverdue = [\s\S]*?\}\);/);
  assert.ok(decision, 'isOverdue assignment not found in email-to-tenant');
  assert.ok(/isChaseable\(/.test(decision[0]),
    'isOverdue must consult isChaseable, otherwise a status=2 invoice still gets chased');
  assert.ok(/createdAt: inv\.created_at/.test(decision[0]),
    'the invoice creation date has to reach the rule for it to mean anything');
  assert.ok(/i\.created_at/.test(invoiceRoute),
    'created_at must be selected, or it arrives undefined and the rule quietly passes');
});

test('the Monday sweep filters on chaseability in SQL, before its LIMIT', () => {
  // Scope to the overdue job first. scheduler.js has a second, unrelated
  // `const [invoices] = await pool.execute(` in the upcoming-reminder job, and
  // matching that one instead made this test pass against the wrong query.
  const jobStart = scheduler.indexOf('async function sendOverdueRemindersForOrg');
  assert.ok(jobStart > -1, 'sendOverdueRemindersForOrg not found');
  const job = scheduler.slice(jobStart, scheduler.indexOf('\nasync function', jobStart + 1));
  const query = job.match(/const \[invoices\] = await pool\.execute\([\s\S]*?\);/);
  assert.ok(query, 'overdue reminder query not found');
  assert.ok(/chaseableSql\('i\.due_on', 'i\.created_at'\)/.test(query[0]),
    'the sweep must filter in SQL so back-dated invoices cannot fill its LIMIT 50');
  // DATEDIFF takes one `today`, chaseableSql takes two, then orgId.
  const binding = query[0].match(/\[([^\]]*)\]\s*\)/);
  assert.ok(binding, 'parameter array not found');
  assert.equal(binding[1].trim(), 'today, today, today, orgId',
    'three placeholders take today; a short bind shifts orgId into a date comparison');
});

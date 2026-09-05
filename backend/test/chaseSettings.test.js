/**
 * The overdue chasing policy: defaults, parsing, and the sweep that reads it.
 *
 * The single most important assertion in here is that `enabled` defaults to 0
 * and that every failure path lands on that default. The weekly sweep had been
 * dormant for a long time because it filtered `status = 0` while the nightly
 * job flips past-due invoices to 2, so reviving it points a working dunning
 * mailer at a backlog years deep. A deploy must not switch that on, and a
 * missing table on an unmigrated org must not either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  loadChaseSettings, parseCategories, serialiseCategories, CHASE_DEFAULTS,
} = require('../src/utils/chaseSettings');
const { isChaseable, chaseableSql, repeatDueSql } = require('../src/utils/overdueChase');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('automatic chasing is off by default', () => {
  assert.equal(CHASE_DEFAULTS.enabled, 0);
});

test('the default category list is rent only, expressed as null', () => {
  // Null rather than a baked-in id: category ids differ per org, and storing one
  // at migration time would need a backfill and would rot when renamed.
  assert.equal(CHASE_DEFAULTS.categories, null);
});

test('an org with no saved row gets the defaults', async () => {
  const pool = { execute: async () => [[undefined]] };
  assert.deepEqual(await loadChaseSettings(pool, '1'), CHASE_DEFAULTS);
});

test('a missing chase_setting table falls back to off, not to sending', async () => {
  const pool = { execute: async () => { throw new Error("Table 'chase_setting' doesn't exist"); } };
  const policy = await loadChaseSettings(pool, '1');
  assert.equal(policy.enabled, 0, 'a load failure must never enable unattended sending');
});

test('saved values are read back, and junk falls back per field', async () => {
  const pool = { execute: async () => [[{
    enabled: 1, categories: '10,20', days_after_due: 3,
    days_after_issue: 'not a number', repeat_days: 14,
  }]] };
  const policy = await loadChaseSettings(pool, '1');
  assert.equal(policy.enabled, 1);
  assert.deepEqual(policy.categories, ['10', '20']);
  assert.equal(policy.days_after_due, 3);
  assert.equal(policy.days_after_issue, CHASE_DEFAULTS.days_after_issue,
    'one unreadable field must not poison the rest');
  assert.equal(policy.repeat_days, 14);
});

test('anything other than 1 in enabled reads as off', async () => {
  for (const raw of [0, null, '', 'yes', 2]) {
    const pool = { execute: async () => [[{ enabled: raw }]] };
    const policy = await loadChaseSettings(pool, '1');
    assert.equal(policy.enabled, 0, `enabled=${JSON.stringify(raw)} must not mean on`);
  }
});

// ---------------------------------------------------------------------------
// Category list handling. These ids are Snowflake bigints.
// ---------------------------------------------------------------------------

test('category ids survive as strings, never parsed as numbers', () => {
  // Parsing would round these together and chase the wrong category.
  const ids = parseCategories('1788404383048813999,1788404383048813998');
  assert.deepEqual(ids, ['1788404383048813999', '1788404383048813998']);
  for (const id of ids) assert.equal(typeof id, 'string');
});

test('blank and ragged lists round-trip to null rather than an empty match', () => {
  // An empty IN () list is a SQL syntax error, and a list of one empty string
  // would match nothing at all while looking configured.
  for (const raw of [null, undefined, '', ' ', ',', ', ,']) {
    assert.equal(parseCategories(raw), null, `parseCategories(${JSON.stringify(raw)})`);
  }
  for (const raw of [null, undefined, [], ['', '  ']]) {
    assert.equal(serialiseCategories(raw), null, `serialiseCategories(${JSON.stringify(raw)})`);
  }
});

test('duplicates are collapsed on save', () => {
  assert.equal(serialiseCategories(['7', '7', ' 7 ', '8']), '7,8');
});

// ---------------------------------------------------------------------------
// The windows, driven by policy
// ---------------------------------------------------------------------------

test('days_after_due delays the first chase', () => {
  const base = { dueOn: '2026-08-26', createdAt: '2026-07-28' };
  assert.equal(isChaseable({ ...base, today: '2026-08-29', daysAfterDue: 5 }), false);
  assert.equal(isChaseable({ ...base, today: '2026-09-01', daysAfterDue: 5 }), true);
});

test('days_after_issue still guards back-dated invoices at any due window', () => {
  // The Ruby case with a 30-day rope on the due date: the issue guard is what
  // stops the chase, not the due date.
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-09-03', today: '2026-09-05',
    daysAfterDue: 0, daysAfterIssue: 7,
  }), false);
});

test('a zero issue guard restores the old behaviour exactly', () => {
  // Someone may legitimately want this. It must be expressible, and it must
  // reproduce the same-day chase rather than something subtly different.
  assert.equal(isChaseable({
    dueOn: '2026-08-26', createdAt: '2026-09-03', today: '2026-09-04', daysAfterIssue: 0,
  }), true);
});

test('day counts reach SQL as integers, never as caller text', () => {
  // MySQL will not bind a placeholder inside an INTERVAL, so these are
  // interpolated. That makes coercion the only thing standing between a setting
  // and the query text.
  const sql = chaseableSql('i.due_on', 'i.created_at', {
    daysAfterDue: '5; DROP TABLE invoice', daysAfterIssue: 14.9,
  });
  assert.ok(!/DROP/i.test(sql), `non-numeric input reached the query: ${sql}`);
  assert.match(sql, /INTERVAL 0 DAY/, 'unparseable day count must fall back to its default');
  assert.match(sql, /INTERVAL 14 DAY/, 'fractional days must truncate, not round up');
  assert.equal((sql.match(/\?/g) || []).length, 2);
});

test('repeatDueSql treats a never-chased invoice as due', () => {
  const sql = repeatDueSql('i.last_chased_at', 7);
  assert.match(sql, /i\.last_chased_at IS NULL OR/,
    'without the NULL branch nothing would ever get its first reminder');
  assert.equal((sql.match(/\?/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const scheduler = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'scheduler.js'), 'utf8');

function overdueJob() {
  const start = scheduler.indexOf('async function sendOverdueRemindersForOrg');
  assert.ok(start > -1, 'sendOverdueRemindersForOrg not found');
  return scheduler.slice(start, scheduler.indexOf('\nasync function', start + 1));
}

test('the sweep bails out before doing any work when disabled', () => {
  const job = overdueJob();
  const guard = job.indexOf('if (!policy.enabled) return;');
  assert.ok(guard > -1, 'the sweep must honour the master switch');
  assert.ok(guard < job.indexOf('pool.execute'),
    'the switch must be checked before the query, not after');
});

test('the sweep applies every policy field', () => {
  const job = overdueJob();
  assert.match(job, /loadChaseSettings\(pool, orgId\)/);
  assert.match(job, /i\.category IN \(\$\{categoryPlaceholders\}\)/);
  assert.match(job, /daysAfterDue: policy\.days_after_due/);
  assert.match(job, /daysAfterIssue: policy\.days_after_issue/);
  assert.match(job, /repeatDueSql\('i\.last_chased_at', policy\.repeat_days\)/);
});

test('the sweep leaves departed tenants alone', () => {
  const job = overdueJob();
  assert.match(job, /l\.status = 1/,
    'a voided lease is not something to bill against');
  assert.match(job, /l\.end_date IS NULL OR l\.end_date >= \?/,
    'someone who moved out must not keep receiving automated demands');
});

test('the invoice is claimed before the send, not stamped after it', () => {
  // Stamping afterwards left a window where two overlapping runs both read
  // last_chased_at IS NULL and both sent. For a dunning letter a duplicate is
  // worse than a delay, so the claim is an atomic conditional update taken
  // first, and released again if the send does not happen.
  const job = overdueJob();
  const claim = job.indexOf('last_chased_at = NOW()');
  assert.ok(claim > -1, 'repeat_days is meaningless without recording the send');
  assert.ok(claim < job.indexOf('sendOverdueToTenant'),
    'the claim must be taken before the send, or concurrent runs double-chase');
  assert.match(job, /if \(claim\.affectedRows === 0\) continue;/,
    'losing the race must skip the invoice, not send anyway');
});

test('a claim is released when the send does not happen', () => {
  const job = overdueJob();
  const releases = job.match(/UPDATE invoice SET last_chased_at = \? WHERE id = \?/g) || [];
  assert.equal(releases.length, 3,
    'every path that claims but does not send must put the old value back: ' +
    'settled-since-selection, declined by the template layer, and thrown. ' +
    'Missing one silences that invoice for a whole repeat_days window');
  assert.match(job, /i\.last_chased_at,/,
    'the previous value has to be selected to be restorable');
});

test('there is no hand-rolled fallback email', () => {
  // sendOverdueToTenant returns null for FOUR reasons: no template, the lease
  // has overdue email switched off (83 of 329 active leases do), the recipient
  // failed the org whitelist, or the send failed. The old fallback treated all
  // four as "improvise one" and called sendMail directly, overriding every one
  // of those controls.
  const job = overdueJob();
  assert.ok(!/sendMail\(/.test(job),
    'the sweep must not send outside the template path, which is what enforces ' +
    'the per-lease toggle and the org email whitelist');
  assert.match(job, /if \(!templateResult\) \{/,
    'a declined send must be recorded and skipped, not worked around');
});

test('reminders bill the outstanding balance, not the invoice face value', () => {
  // Twelve open rent invoices are part paid, one by HK$106,170 against
  // HK$162,203. Passing i.amount would demand the whole sum back.
  const job = overdueJob();
  // The query filters on it; the send quotes the value re-read after the claim.
  assert.match(job, /overdueAmount: owed/,
    'the email must quote what is still owed at the moment it goes out');
  assert.match(job, /AS outstanding/, 'outstanding has to be computed in the query');
  assert.match(job, /HAVING outstanding > 0/,
    'a fully settled invoice must drop out even if its status flag is stale');
});

test('the category list is bound, not interpolated', () => {
  const job = overdueJob();
  const query = job.match(/const \[invoices\] = await pool\.execute\([\s\S]*?\);/);
  assert.ok(query, 'overdue query not found');
  assert.match(query[0], /\.\.\.categoryIds/,
    'category ids must be spread into the parameter list, never pasted into the SQL');
});

// ---------------------------------------------------------------------------
// The migration. It runs against every org database, so it has to be idempotent
// and its column defaults have to agree with the code defaults above: a row
// created by any path other than the settings screen still has to read as off.
// ---------------------------------------------------------------------------

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations-org', '077_chase_setting.sql'), 'utf8');

test('the migration is safe to re-run', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS chase_setting/);
  assert.match(migration, /information_schema\.COLUMNS/,
    'the invoice ALTER must be guarded; the runner applies files to every org db');
  assert.ok(!/DROP TABLE|TRUNCATE/i.test(migration),
    'a per-org migration must never destroy data');
});

test('the stored default for enabled matches the code default', () => {
  const column = migration.match(/enabled\s+TINYINT\s+NOT NULL\s+DEFAULT\s+(\d+)/);
  assert.ok(column, 'enabled column definition not found');
  assert.equal(Number(column[1]), CHASE_DEFAULTS.enabled,
    'a row inserted outside the settings screen must still read as off');
});

test('the migration adds the column repeat_days depends on', () => {
  assert.match(migration, /ADD COLUMN last_chased_at TIMESTAMP NULL/,
    'repeat_days is per invoice and email_log has no invoice_id to read');
});

// ---------------------------------------------------------------------------
// Saving the policy is a privileged act: it can switch on a job that emails real
// tenants with nobody reviewing the output.
// ---------------------------------------------------------------------------

test('saving the policy requires a permission, reading it does not', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'settings.js'), 'utf8');
  const put = routes.match(/router\.put\('\/setting\/payment-reminders'[^\n]*/);
  assert.ok(put, 'PUT /setting/payment-reminders not found');
  assert.match(put[0], /requirePermission\(/,
    'plain authenticate would let any logged-in user start mailing tenants');
  const get = routes.match(/router\.get\('\/setting\/payment-reminders'[^\n]*/);
  assert.ok(get, 'GET /setting/payment-reminders not found');
  assert.ok(!/requirePermission\(/.test(get[0]),
    'the settings screen still has to be able to render the current policy');
});

// ---------------------------------------------------------------------------
// The SELECT is a snapshot. Between it and the send, a payment can land, an
// invoice can be written off or deleted. Everything consequential is re-tested
// after the claim rather than trusted from the snapshot.
// ---------------------------------------------------------------------------

test('the claim re-tests status and deletion, not just the repeat window', () => {
  const job = overdueJob();
  const claim = job.match(/UPDATE invoice SET last_chased_at = NOW\(\)[\s\S]*?`,/);
  assert.ok(claim, 'claim update not found');
  assert.match(claim[0], /status IN \(0, 2\)/,
    'an invoice settled since the SELECT must not still be claimable');
  assert.match(claim[0], /deleted_at IS NULL/,
    'an invoice deleted since the SELECT must not still be claimable');
});

test('the amount emailed is re-read after the claim, not taken from the snapshot', () => {
  const job = overdueJob();
  assert.match(job, /overdueAmount: owed/,
    'a payment landing mid-run would otherwise be quoted at the older, higher figure');
  assert.match(job, /if \(!\(owed > 0\)\) \{/,
    'an invoice paid in full mid-run must be released, not demanded');
  const reread = job.indexOf('AS outstanding\n           FROM invoice i WHERE i.id = ?');
  assert.ok(reread > job.indexOf('claim.affectedRows'),
    'the re-read belongs after the claim, so it reflects the state being sent about');
});

// ---------------------------------------------------------------------------
// The manual button and the org policy: which half of it applies by hand.
// ---------------------------------------------------------------------------

test('the manual button honours days_after_issue but not days_after_due', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'invoice.js'), 'utf8');
  const decision = routes.match(/const isOverdue = [\s\S]*?\}\);/);
  assert.ok(decision, 'isOverdue assignment not found');
  // days_after_issue is a correctness guard: nobody, by hand or otherwise,
  // should demand payment for a bill the tenant has not yet had.
  assert.match(decision[0], /daysAfterIssue: policy\.days_after_issue/,
    'the built-in 7 must not override a configured value');
  // days_after_due is the cadence of the unattended job. A person choosing to
  // chase one invoice is not bound by it.
  assert.ok(!/daysAfterDue/.test(decision[0]),
    'the manual button must not inherit the automated cadence');
  assert.ok(!/isRent/.test(decision[0]),
    'nor the automated category scope');
});

test('the queue cannot starve behind its own LIMIT', () => {
  // repeat_days matches the weekly cron, so ordering by due_on alone makes the
  // same oldest 50 eligible again every Monday and an invoice at position 51 is
  // never reached. Never-chased invoices have to outrank already-chased ones.
  const job = overdueJob();
  assert.match(job, /ORDER BY i\.last_chased_at IS NULL DESC, i\.last_chased_at ASC, i\.due_on ASC/,
    'never-chased first, then longest-since-chased, then oldest due');
});

// ---------------------------------------------------------------------------
// Findings from the Grok review that survived the GPT pass.
// ---------------------------------------------------------------------------

test('the sweep never duns a tenant for an outflow invoice', () => {
  // type = 1 is money going OUT: a deposit refund, a credit, a reimbursement.
  // The settings picker counts inflow invoices, so ticking Deposit looks safe
  // there while the sweep would tell a tenant they are overdue on money the
  // landlord owes THEM. Hidden by the rent-only default until someone uses the
  // screen as it is drawn.
  const job = overdueJob();
  assert.match(job, /AND i\.type = 0/,
    'the sweep must be inflow-only, matching what the category picker counts');
});

test('a chaser sent by hand is remembered', () => {
  // last_chased_at is the only per-invoice memory of a reminder. Without the
  // manual button writing it, a chaser sent on Friday is invisible to Monday's
  // sweep, which reads NULL and sends a second one.
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'invoice.js'), 'utf8');
  assert.match(routes, /if \(usedTemplate === 'Overdue-Tenant'\) \{[\s\S]*?last_chased_at = NOW\(\)/,
    'the manual endpoint must stamp last_chased_at when it sends an overdue chaser');
  // An ordinary invoice email is not a demand and must not suppress a reminder.
  const stamp = routes.indexOf("if (usedTemplate === 'Overdue-Tenant') {");
  assert.ok(stamp > -1);
  const block = routes.slice(stamp, stamp + 600);
  assert.ok(!/usedTemplate === 'Invoice-Tenant'/.test(block),
    'only an actual chaser counts as a chase');
});

test('a negative day count cannot invert a SQL window', () => {
  // Number('5; DROP TABLE ...') is NaN and was already caught. -1 is a
  // perfectly good number, and INTERVAL -1 DAY is valid MySQL that flips the
  // comparison: a due test becomes "due before tomorrow", a repeat test becomes
  // always true. The HTTP route clamps, but a hand-edited row does not pass
  // through it.
  const sql = chaseableSql('i.due_on', 'i.created_at', { daysAfterDue: -5, daysAfterIssue: -9 });
  assert.ok(!/INTERVAL -/.test(sql), `a negative interval reached the query: ${sql}`);
  assert.equal((sql.match(/INTERVAL 0 DAY/g) || []).length, 2);
  assert.equal(isChaseable({
    dueOn: '2026-09-05', createdAt: '2026-01-01', today: '2026-09-05', daysAfterDue: -5,
  }), false, 'a negative rope must not make a not-yet-due invoice chaseable');
});

test('repeat_days has a floor of one day, everywhere it is read', async () => {
  // At 0 an invoice chased this morning is due again this afternoon, so one run
  // could mail the same tenant repeatedly.
  assert.match(repeatDueSql('i.last_chased_at', 0), /INTERVAL 1 DAY/);
  assert.match(repeatDueSql('i.last_chased_at', -3), /INTERVAL 1 DAY/);
  const pool = { execute: async () => [[{ enabled: 1, repeat_days: 0 }]] };
  const policy = await loadChaseSettings(pool, '1');
  assert.equal(policy.repeat_days, 1, 'the floor must hold on read, not only in the route');
});

test('a negative day count stored directly in the database reads as zero', async () => {
  const pool = { execute: async () => [[{ enabled: 1, days_after_due: -30, days_after_issue: -1 }]] };
  const policy = await loadChaseSettings(pool, '1');
  assert.equal(policy.days_after_due, 0);
  assert.equal(policy.days_after_issue, 0);
});

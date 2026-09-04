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

test('last_chased_at is stamped only after a send succeeded', () => {
  const job = overdueJob();
  const stamp = job.indexOf('last_chased_at = NOW()');
  assert.ok(stamp > -1, 'repeat_days is meaningless without recording the send');
  assert.ok(stamp > job.indexOf('sendOverdueToTenant'),
    'stamping before the send would silence a failed invoice for a whole cycle');
  assert.ok(stamp < job.indexOf('sent++'),
    'the stamp belongs inside the same try, so a failed stamp is not counted as sent');
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

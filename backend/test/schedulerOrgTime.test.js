const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { markOverdueInvoicesForOrg, promoteServiceTasksForOrg } = require('../src/services/scheduler');
const { orgToday } = require('../src/utils/orgTime');

// These tests exist because a previous timezone fix shipped with tests that
// exercised the HELPERS and passed with every bug reintroduced at the CALL SITES.
// Everything below drives the real job function or reads the real source.

// Records the SQL and params of every query, returns empty results.
function fakePool() {
  const queries = [];
  return {
    queries,
    execute: async (sql, params) => {
      queries.push({ sql, params });
      return [{ affectedRows: 0 }];
    },
  };
}

test('markOverdue compares due_on against the OPERATOR date, not CURDATE()', async () => {
  // The live regression this guards: at 16:05 UTC the server calendar date is
  // still yesterday while Hong Kong is already tomorrow. markOverdue now fires
  // at 00:05 HK — i.e. inside that band — so a CURDATE() here would compare
  // against yesterday and leave invoices un-flagged for a full extra day.
  const pool = fakePool();

  await markOverdueInvoicesForOrg(pool, '8300127259922432');

  const q = pool.queries[0];
  assert.ok(!/CURDATE\(\)/.test(q.sql), 'markOverdue must not resolve the date on the DB server');
  assert.equal(q.params[0], orgToday(), 'the bound date must be the operator calendar date');
});

test('service auto-promote binds the operator date too', async () => {
  const pool = fakePool();

  await promoteServiceTasksForOrg(pool, '8300127259922432');

  const q = pool.queries[0];
  assert.ok(!/CURDATE\(\)/.test(q.sql));
  assert.ok(q.params.includes(orgToday()));
});

// --- Source-level guards ---------------------------------------------------
// The remaining jobs need far more DB scaffolding than their risk justifies, but
// the two mistakes that would break them are both visible in the source, and both
// are silent at runtime. Pinning them here is cheap and catches a careless edit.
// Comments stripped first: the file documents these very rules, and matching the
// prose instead of the code would make every guard below pass or fail for the
// wrong reason.
const SRC = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no job resolves a business date on the database server', () => {
  // CURDATE() reads MySQL's @@time_zone (SYSTEM = UTC on production), so it
  // disagrees with the operator's calendar for eight hours out of every
  // twenty-four. Every business date must be bound from orgToday().
  assert.equal(SRC.includes('CURDATE()'), false,
    'scheduler.js still resolves a date with CURDATE() — bind orgToday() instead');
});

test('no job derives "today" from the server clock', () => {
  // toDateString(new Date()) uses local getters, and the process runs UTC.
  // (toDateString is still correct for normalising a DATE column mysql2 already
  // returned at local midnight — only "what is today" was wrong.)
  assert.equal(SRC.includes('toDateString(new Date())'), false,
    'scheduler.js still reads today from the server clock — use orgTodayDate()');
});

test('every scheduled job declares the operator timezone', () => {
  // node-cron defaults to the SERVER zone. Without this, '0 10 * * *' fires at
  // 18:00 Hong Kong — which is what production was actually doing.
  const scheduleCount = (SRC.match(/cron\.schedule\(/g) || []).length;
  const timezoneCount = (SRC.match(/timezone: ORG_TIME_ZONE/g) || []).length;

  assert.ok(scheduleCount > 0, 'expected to find scheduled jobs');
  assert.equal(timezoneCount, scheduleCount,
    `${scheduleCount} cron jobs but only ${timezoneCount} declare a timezone`);
});

test('no cron job pins a hardcoded zone string instead of the shared constant', () => {
  assert.equal(/timezone: '/.test(SRC), false,
    'use ORG_TIME_ZONE so the zone is configured in one place');
});

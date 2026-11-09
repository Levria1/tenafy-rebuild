const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVacancies } = require('../src/routes/advertising');

// Leasing -> Vacancy (page view). A unit occupied today whose lease hands straight
// over to a follow-on lease must show as expiring at the END of that follow-on,
// not vanish from both lists until the handover day (FLT 1G, 2026-11-09).

function capturingPool() {
  const seen = [];
  return {
    seen,
    execute: async (sql) => { seen.push(sql); return [[]]; },
  };
}

function expiringSql(seen) {
  const sql = seen.find(s => /AS days_left/.test(s) && /FROM leasing l\s/.test(s));
  assert.ok(sql, 'expiring query was issued');
  return sql;
}

test('page view gates EXPIRING on the unit being occupied today, not on the latest lease having started', async () => {
  const pool = capturingPool();
  await computeVacancies(pool, 'org', { page: true });
  const sql = expiringSql(pool.seen);
  assert.doesNotMatch(sql, /AND l\.start_date <=/, 'the latest lease may be a follow-on that starts later');
  assert.match(sql, /AND EXISTS \(\s*SELECT 1 FROM leasing lc\s+WHERE lc\.unit_id = u\.id/, 'unit must be occupied today');
  // The latest-lease rule is still what picks the date.
  assert.match(sql, /l2\.end_date > l\.end_date/);
});

test('scheduler view is unchanged: no occupancy gate on EXPIRING', async () => {
  const pool = capturingPool();
  await computeVacancies(pool, 'org', { page: false, settings: {} });
  const sql = expiringSql(pool.seen);
  assert.doesNotMatch(sql, /AND l\.start_date <=/);
  assert.doesNotMatch(sql, /FROM leasing lc/);
});

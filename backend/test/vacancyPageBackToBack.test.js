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

function poolWithExpiring(row) {
  return {
    execute: async (sql) => {
      if (/AS days_left/.test(sql) && /FROM leasing l\s/.test(sql)) return [[row]];
      return [[]];
    },
  };
}

const BACK_TO_BACK_ROW = {
  lease_id: '902', current_lease_id: '901', current_rent: '7400.00',
  contract_type: 1, rent: '7900.00', end_date: '2026-12-15', days_left: 36,
  unit_id: '1', unit_name: '1G', property_id: '9', property_name: 'Fuk Lo Tsun',
  rent_price_min: '6900', rent_price_max: '8900',
};

test('page rows carry the posting rent the Scheduler would use, and today\'s rent separately', async () => {
  const { vacancies } = await computeVacancies(poolWithExpiring(BACK_TO_BACK_ROW), 'org', { page: true });
  assert.equal(vacancies.length, 1);
  const r = vacancies[0];
  assert.equal(r.posting_rent, 8900, 'still let → top of the range');
  assert.equal(r.posting_tier, 'high');
  assert.equal(r.current_rent, 7400, 'what the tenant on the unit today pays');
  assert.equal(r.current_lease_is_row, false);
  assert.equal(r.rent, 7900, 'row rent stays the row lease');
});

test('page posting rent falls back to the lease rent, untiered, when the unit has no range', async () => {
  const row = { ...BACK_TO_BACK_ROW, current_lease_id: '902', rent_price_min: null, rent_price_max: null };
  const { vacancies: [r] } = await computeVacancies(poolWithExpiring(row), 'org', { page: true });
  assert.equal(r.posting_rent, 7900);
  assert.equal(r.posting_tier, null);
  assert.equal(r.current_lease_is_row, true);
});

test('page SQL selects today\'s lease rent; scheduler SQL does not', async () => {
  const a = capturingPool();
  await computeVacancies(a, 'org', { page: true });
  assert.match(expiringSql(a.seen), /AS current_rent/);
  const b = capturingPool();
  await computeVacancies(b, 'org', { page: false, settings: {} });
  assert.doesNotMatch(expiringSql(b.seen), /current_rent/);
});

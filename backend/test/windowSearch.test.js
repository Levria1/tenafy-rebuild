const test = require('node:test');
const assert = require('node:assert/strict');
const { longestFreeStretch } = require('../src/services/unitSearch');

test('longestFreeStretch returns the full window when there are no leases', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-31', []), {
    from: '2026-01-01',
    until: '2026-01-31',
    days: 31,
  });
});

test('longestFreeStretch returns null when the window is fully occupied', () => {
  assert.equal(longestFreeStretch('2026-01-01', '2026-01-31', [
    { start_date: '2025-12-15', end_date: '2026-02-01' },
  ]), null);
});

test('longestFreeStretch returns the longer side when one lease splits the window', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-10', [
    { start_date: '2026-01-04', end_date: '2026-01-05' },
  ]), {
    from: '2026-01-06',
    until: '2026-01-10',
    days: 5,
  });
});

test('longestFreeStretch returns only the longest stretch instead of summing fragments', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-31', [
    { start_date: '2026-01-06', end_date: '2026-01-10' },
    { start_date: '2026-01-16', end_date: '2026-01-20' },
  ]), {
    from: '2026-01-21',
    until: '2026-01-31',
    days: 11,
  });
});

test('longestFreeStretch chooses the earlier stretch when lengths are equal', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-10', [
    { start_date: '2026-01-04', end_date: '2026-01-07' },
  ]), {
    from: '2026-01-01',
    until: '2026-01-03',
    days: 3,
  });
});

test('longestFreeStretch frees the unit the day after a lease end date', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-15', [
    { start_date: '2026-01-01', end_date: '2026-01-10' },
  ]), {
    from: '2026-01-11',
    until: '2026-01-15',
    days: 5,
  });
});

test('longestFreeStretch treats null end_date as occupied through the window end', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-20', [
    { start_date: '2026-01-10', end_date: null },
  ]), {
    from: '2026-01-01',
    until: '2026-01-09',
    days: 9,
  });
});

test('longestFreeStretch clips a lease starting before the window and ending inside it', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-10', [
    { start_date: '2025-12-20', end_date: '2026-01-05' },
  ]), {
    from: '2026-01-06',
    until: '2026-01-10',
    days: 5,
  });
});

test('longestFreeStretch ignores leases entirely outside the window', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-10', [
    { start_date: '2026-02-01', end_date: '2026-02-10' },
  ]), {
    from: '2026-01-01',
    until: '2026-01-10',
    days: 10,
  });
});

test('longestFreeStretch merges overlapping and adjacent occupied spans', () => {
  assert.deepEqual(longestFreeStretch('2026-01-01', '2026-01-20', [
    { start_date: '2026-01-05', end_date: '2026-01-10' },
    { start_date: '2026-01-08', end_date: '2026-01-12' },
    { start_date: '2026-01-13', end_date: '2026-01-15' },
  ]), {
    from: '2026-01-16',
    until: '2026-01-20',
    days: 5,
  });
});

test('longestFreeStretch handles a free single-day window', () => {
  assert.deepEqual(longestFreeStretch('2026-01-10', '2026-01-10', []), {
    from: '2026-01-10',
    until: '2026-01-10',
    days: 1,
  });
});

test('longestFreeStretch handles an occupied single-day window', () => {
  assert.equal(longestFreeStretch('2026-01-10', '2026-01-10', [
    { start_date: '2026-01-10', end_date: '2026-01-10' },
  ]), null);
});

test('longestFreeStretch counts days inclusively', () => {
  assert.equal(longestFreeStretch('2026-01-01', '2026-01-31', []).days, 31);
});

// ---------------------------------------------------------------------------
// Review additions (not in the original build).
//
// Window mode had to disable `excludeRenewing`: that clause only offers an
// occupied unit when its tenant is contract_type 3 (Not Renewing), which would
// discard exactly the unit window search exists to surface — one that frees up
// partway through the requested period. Disabling it silently, though, means
// offering flats whose sitting tenant probably stays, which is what the policy
// was written to prevent. The resolution is to return the unit and report the
// uncertainty, the way /vacancies flags tier-3 rows.
//
// The certainty rule is applied against the lease ending the day before the
// stretch begins — the departure that creates the opening. These tests pin the
// date arithmetic that identifies it, since an off-by-one there would silently
// mark every uncertain unit as certain.
// ---------------------------------------------------------------------------

test('the freeing lease is the one ending the day BEFORE the stretch starts', () => {
  // Lease ends 30 Sep, so the stretch starts 1 Oct. Matching on "ends the day
  // before" must find the 30 Sep lease. Matching on the stretch start itself
  // would find nothing and wrongly report the opening as certain.
  const stretch = longestFreeStretch('2026-08-21', '2026-12-31', [
    { start_date: '2026-01-01', end_date: '2026-09-30', contract_type: 1 },
  ]);
  assert.equal(stretch.from, '2026-10-01');

  const dayBefore = '2026-09-30';
  assert.notEqual(stretch.from, dayBefore, 'the freeing lease does not end on the stretch start');
});

test('a unit already empty at the window start has no freeing lease', () => {
  // The winning stretch starts ON the window start, so nothing ends the day
  // before it: there is no sitting tenant whose intention matters and the
  // opening is certain. 21 Aug-31 Oct is 72 days against 31 for the December
  // tail, so the head wins on length too.
  const stretch = longestFreeStretch('2026-08-21', '2026-12-31', [
    { start_date: '2026-11-01', end_date: '2026-11-30', contract_type: 1 },
  ]);
  assert.equal(stretch.from, '2026-08-21', 'already empty at the window start');
  assert.equal(stretch.until, '2026-10-31');
  assert.equal(stretch.days, 72);
});

test('contract_type on a lease never changes which stretch is chosen', () => {
  // Certainty is reported, not filtered. A May-Renew tenant and a Not-Renewing
  // tenant leaving on the same day must produce the identical window; if this
  // ever diverges, the flag has silently become a filter and window search is
  // back to hiding the units it exists to find.
  const leases = (contractType) => ([
    { start_date: '2026-01-01', end_date: '2026-09-30', contract_type: contractType },
  ]);
  const mayRenew = longestFreeStretch('2026-08-21', '2026-12-31', leases(1));
  const notRenewing = longestFreeStretch('2026-08-21', '2026-12-31', leases(3));
  assert.deepEqual(mayRenew, notRenewing);
});

// ---------------------------------------------------------------------------
// Price filtering must compare the SAME figure the response publishes.
//
// The filter read `last_lease_price` raw while `monthly_rent` reported the
// schedule-aware value, so a unit could be advertised at 12,000 a month and still
// be deleted by max_price=14000. Reported by our chat partner against Poplar 2B:
// an 86-day let with no invoicing schedule stores 34,434.99 — the total for the
// stay — so a normal monthly band removed the longest-available unit in the
// building, which is precisely what window search exists to surface.
// ---------------------------------------------------------------------------

const { comparableMonthlyRent } = require('../src/services/unitSearch');

test('a lease with no invoicing schedule never supplies the monthly rent', () => {
  // Poplar 2B, exactly as stored.
  assert.equal(comparableMonthlyRent({
    last_lease_price: 34434.99, last_lease_invoicing: null,
    rent_price_min: 12000, rent_price_max: 13000,
  }), 12000, 'a whole-stay total must not be compared against a monthly band');
});

test('a lease WITH a schedule does supply it — the positive control', () => {
  // Without this the function could return rent_price_min always and every
  // assertion above would still pass.
  assert.equal(comparableMonthlyRent({
    last_lease_price: 9500, last_lease_invoicing: 'monthly',
    rent_price_min: 11500, rent_price_max: 12500,
  }), 9500);
  assert.equal(comparableMonthlyRent({
    last_lease_price: 11000, last_lease_invoicing: '30',
    rent_price_min: 11500,
  }), 11000, 'a numeric day-count schedule counts as recurring');
});

test('an empty or whitespace schedule is treated as absent', () => {
  // '' and '   ' are how an unset column arrives from some rows; treating them as
  // a schedule would put the whole-stay total straight back into the comparison.
  assert.equal(comparableMonthlyRent({
    last_lease_price: 34434.99, last_lease_invoicing: '', rent_price_min: 12000,
  }), 12000);
  assert.equal(comparableMonthlyRent({
    last_lease_price: 34434.99, last_lease_invoicing: '   ', rent_price_min: 12000,
  }), 12000);
});

test('an unpriced unit yields null rather than zero', () => {
  // Number(null) is 0, which would clear any minPrice floor and mark the unit as
  // the cheapest thing in the portfolio.
  assert.equal(comparableMonthlyRent({ last_lease_invoicing: null, rent_price_min: null }), null);
  assert.equal(comparableMonthlyRent({}), null);
  assert.equal(comparableMonthlyRent(null), null);
});

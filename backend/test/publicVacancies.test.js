const test = require('node:test');
const assert = require('node:assert/strict');
const {
  vacancyToPublicShape,
  unitDetailDaysToAvailable,
} = require('../src/utils/advertisingPlan');

function row(overrides = {}) {
  return {
    unit_id: 'u1',
    unit_name: '5B',
    property_id: 'p1',
    property_name: "Gilman's Bazaar",
    unit_type: 'apartment',
    beds: 1,
    baths: 1,
    size: 320,
    rent: 12000,
    tier: 2,
    intent: 'NR',
    days_left: 34,
    end_date: '2026-09-15',
    ...overrides,
  };
}

test('tier 1 maps to available now and certain', () => {
  const result = vacancyToPublicShape(row({ tier: 1, intent: 'Unset', days_left: -12, end_date: null }));

  assert.equal(result.availability.status, 'now');
  assert.equal(result.availability.available_from, null);
  assert.equal(result.availability.days_until, 0);
  assert.equal(result.availability.certain, true);
});

test('tier 2 available_from equals the lease end date', () => {
  const result = vacancyToPublicShape(row({ tier: 2, end_date: '2026-09-15', days_left: 34 }));

  // Same-day turnover: free on the end date; must stay aligned with days_until.
  assert.equal(result.availability.available_from, '2026-09-15');
  assert.equal(result.availability.status, 'from_date');
  assert.equal(result.availability.days_until, 34);
  assert.equal(result.availability.certain, true);
});

test('tier 3 stays uncertain even with a valid end date', () => {
  const result = vacancyToPublicShape(row({ tier: 3, intent: 'MR', end_date: '2026-09-15' }));

  // TaneChat uses this false value to choose the caveated wording.
  assert.equal(result.availability.certain, false);
  assert.equal(result.availability.available_from, '2026-09-15');
});

test('tier 2 with no end date has no promiseable date', () => {
  const result = vacancyToPublicShape(row({ tier: 2, end_date: null }));

  assert.equal(result.availability.available_from, null);
  assert.equal(result.availability.certain, false);
});

test('available_from preserves month-end end dates', () => {
  const result = vacancyToPublicShape(row({ end_date: '2026-08-31' }));

  assert.equal(result.availability.available_from, '2026-08-31');
});

test('available_from preserves year-boundary end dates', () => {
  const result = vacancyToPublicShape(row({ end_date: '2026-12-31' }));

  assert.equal(result.availability.available_from, '2026-12-31');
});

test('public vacancy dates are not Z-suffixed ISO strings', () => {
  const result = vacancyToPublicShape(row({ end_date: '2026-12-31' }));

  assert(!JSON.stringify(result).includes('Z"'));
});

test('scheduled lease publishes the lease figure with rent_basis lease', () => {
  const result = vacancyToPublicShape(row({
    invoicing: 'monthly',
    rent: 12000,
    rent_price_min: 8800,
    rent_price_max: 10000,
  }));

  assert.equal(result.rent, '12000.00');
  assert.equal(result.rent_basis, 'lease');
  assert.equal(result.rent_price_min, '8800.00');
  assert.equal(result.rent_price_max, '10000.00');
});

test('asking_rent uses high tier while the unit is still occupied, without changing existing rent fields', () => {
  const result = vacancyToPublicShape(row({
    invoicing: 'monthly',
    rent: 12000,
    rent_price_min: 14000,
    rent_price_max: 16500,
    days_left: 56,
  }));

  assert.deepEqual(result.asking_rent, {
    amount: '16500.00',
    tier: 'high',
    min: '14000.00',
    max: '16500.00',
  });
  assert.equal(result.rent, '12000.00');
  assert.equal(result.rent_basis, 'lease');
  assert.equal(result.rent_price_min, '14000.00');
  assert.equal(result.rent_price_max, '16500.00');
});

test('asking_rent stays at the top of the range right up to the move-out day', () => {
  // 42 and 41 days used to be the mid/low boundary. Both are now high: we do not
  // start conceding rent to a prospect while the tenant is still in the flat.
  for (const days of [42, 41, 1, 0]) {
    const result = vacancyToPublicShape(row({
      rent_price_min: 14000,
      rent_price_max: 16500,
      days_left: days,
    }));
    assert.equal(result.asking_rent.tier, 'high', `${days} days out`);
    assert.equal(result.asking_rent.amount, '16500.00', `${days} days out`);
  }
});

test('already-vacant asking_rent uses raw negative days_left despite clamped availability', () => {
  // availability.days_until is clamped to 0 for a vacant unit, but the asking rent
  // must read the real negative figure — otherwise an empty flat would price as
  // though it were still occupied.
  const result = vacancyToPublicShape(row({
    tier: 1,
    rent_price_min: 14000,
    rent_price_max: 16500,
    days_left: -12,
    end_date: null,
  }));

  assert.equal(result.availability.days_until, 0);
  assert.equal(result.asking_rent.tier, 'mid');
  assert.equal(result.asking_rent.amount, '15250.00');
});

test('asking_rent is null when no price bounds exist', () => {
  const result = vacancyToPublicShape(row({
    rent_price_min: null,
    rent_price_max: null,
  }));

  assert.equal(result.asking_rent, null);
});

test('invoicing NULL publishes advertised rent, not the lease figure', () => {
  const result = vacancyToPublicShape(row({
    invoicing: null,
    rent: 10200,
    rent_price_min: 8800,
    rent_price_max: 10000,
  }));

  assert.equal(result.rent, '8800.00');
  assert.equal(result.rent_basis, 'advertised');
});

test('empty invoicing is treated the same as NULL', () => {
  const result = vacancyToPublicShape(row({
    invoicing: '',
    rent: 10200,
    rent_price_min: 8800,
  }));

  assert.equal(result.rent, '8800.00');
  assert.equal(result.rent_basis, 'advertised');
});

test('no schedule and no advertised rent publishes null rent and basis', () => {
  const result = vacancyToPublicShape(row({
    invoicing: null,
    rent: 10200,
    rent_price_min: null,
  }));

  assert.equal(result.rent, null);
  assert.equal(result.rent_basis, null);
});

test('Mong Kok 3B-style stay total is never published as monthly rent', () => {
  const result = vacancyToPublicShape(row({
    invoicing: null,
    rent: 113638.99,
    rent_price_min: 8800,
  }));

  assert.equal(result.rent, '8800.00');
  assert.equal(result.rent_basis, 'advertised');
  assert.notEqual(result.rent, '113638.99');
});

test('unit detail day count matches DATEDIFF(end_date, today) semantics', () => {
  assert.equal(unitDetailDaysToAvailable('2026-10-16', '2026-08-21'), 56);
  assert.equal(unitDetailDaysToAvailable('2026-08-21', '2026-08-21'), 0);
  assert.equal(unitDetailDaysToAvailable('2026-08-09', '2026-08-21'), -12);
  assert.equal(unitDetailDaysToAvailable(null, '2026-08-21'), null);
});

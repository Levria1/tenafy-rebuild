const test = require('node:test');
const assert = require('node:assert/strict');
const { vacancyToPublicShape } = require('../src/utils/advertisingPlan');

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

test('tier 2 available_from is the day after lease end', () => {
  const result = vacancyToPublicShape(row({ tier: 2, end_date: '2026-09-15', days_left: 34 }));

  // Off by one here tells a customer they can move in while someone still lives there.
  assert.equal(result.availability.available_from, '2026-09-16');
  assert.equal(result.availability.status, 'from_date');
  assert.equal(result.availability.days_until, 34);
  assert.equal(result.availability.certain, true);
});

test('tier 3 stays uncertain even with a valid end date', () => {
  const result = vacancyToPublicShape(row({ tier: 3, intent: 'MR', end_date: '2026-09-15' }));

  // TaneChat uses this false value to choose the caveated wording.
  assert.equal(result.availability.certain, false);
  assert.equal(result.availability.available_from, '2026-09-16');
});

test('tier 2 with no end date has no promiseable date', () => {
  const result = vacancyToPublicShape(row({ tier: 2, end_date: null }));

  assert.equal(result.availability.available_from, null);
  assert.equal(result.availability.certain, false);
});

test('available_from crosses month end', () => {
  const result = vacancyToPublicShape(row({ end_date: '2026-08-31' }));

  assert.equal(result.availability.available_from, '2026-09-01');
});

test('available_from crosses year boundary', () => {
  const result = vacancyToPublicShape(row({ end_date: '2026-12-31' }));

  assert.equal(result.availability.available_from, '2027-01-01');
});

test('public vacancy dates are not Z-suffixed ISO strings', () => {
  const result = vacancyToPublicShape(row({ end_date: '2026-12-31' }));

  assert(!JSON.stringify(result).includes('Z"'));
});

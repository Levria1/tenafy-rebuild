const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRIORITY_OTHER,
  manualVacancyToRow,
  vacancyToPublicShape,
  matchesFreeOn,
  overrideAppliesTo,
  leaseChangedForOverride,
  pickVacancyRow,
} = require('../src/utils/advertisingPlan');
const { deriveDefaultVacancyExpiry } = require('../src/routes/advertising');

const override = {
  id: '922337203685',
  available_from: '2026-10-15',
  expires_on: '2026-10-20',
  reason: 'Tenant may move out early',
  advertising_enabled: 1,
  inquiry_enabled: 0,
};

const unitRow = {
  unit_id: '101',
  unit_name: '5B',
  unit_type: 'apartment',
  beds: 1,
  baths: 1,
  size: 320,
  rent: 12000,
  rent_price_min: 11800,
  rent_price_max: 12500,
  listing_url: 'https://example.test/unit/101',
  template_id: '201',
  template_name: 'Default',
  property_id: '301',
  property_name: 'Hollywood',
  street_address: '1 Hollywood Road',
  district: 'Sheung Wan',
  city: 'Hong Kong',
};

function manualRow(overrides = {}) {
  return manualVacancyToRow({ ...override, ...overrides }, unitRow, '2026-10-01');
}

function normalRow(overrides = {}) {
  return {
    unit_id: '102',
    unit_name: '6A',
    property_id: '302',
    property_name: 'Central House',
    tier: 2,
    intent: 'NR',
    days_left: 13,
    end_date: '2026-10-14',
    ...overrides,
  };
}

test('manualVacancyToRow marks manual overrides as uncertain tier-three rows', () => {
  const row = manualRow();

  assert.equal(row.tier, PRIORITY_OTHER);
  assert.equal(row.intent, 'Manual');
  assert.equal(row.source, 'manual');
});

test('manual available_from round-trips exactly through vacancyToPublicShape', () => {
  const shaped = vacancyToPublicShape(manualRow());

  assert.equal(shaped.availability.available_from, override.available_from);
});

test('manual rows are never certain availability', () => {
  const shaped = vacancyToPublicShape(manualRow());

  // TaneChat uses this to avoid stating a tentative early move-out as firm.
  assert.equal(shaped.availability.certain, false);
});

test('normal rows expose lease source and no manual block', () => {
  const shaped = vacancyToPublicShape(normalRow());

  assert.equal(shaped.source, 'lease');
  assert.equal(Object.hasOwn(shaped, 'manual'), false);
});

test('manual public shape hides override audit fields and private reason', () => {
  const shaped = vacancyToPublicShape(manualRow());

  // Privacy guarantee: operator notes can include sensitive tenant context and
  // must not leak to partner/prospect payloads.
  assert.equal(shaped.source, 'manual');
  assert.equal(Object.hasOwn(shaped, 'manual'), false);
  assert.equal(Object.hasOwn(shaped, 'reason'), false);
  assert.equal(JSON.stringify(shaped).includes(override.reason), false);
});

test('manual rows are hidden by max_tier 1 and 2 and visible at 3', () => {
  const row = manualRow();

  assert.equal(Number(row.tier) <= 1, false);
  assert.equal(Number(row.tier) <= 2, false);
  assert.equal(Number(row.tier) <= 3, true);
});

test('matchesFreeOn respects a manual row available_from date', () => {
  const shaped = vacancyToPublicShape(manualRow());

  assert.equal(matchesFreeOn(shaped, '2026-10-14'), false);
  assert.equal(matchesFreeOn(shaped, '2026-10-15'), true);
});

test('overrideAppliesTo has no cross-audience fallback', () => {
  assert.equal(overrideAppliesTo({ advertising_enabled: 1, inquiry_enabled: 0 }, 'advertising'), true);
  assert.equal(overrideAppliesTo({ advertising_enabled: 0, inquiry_enabled: 1 }, 'advertising'), false);
  assert.equal(overrideAppliesTo({ advertising_enabled: 0, inquiry_enabled: 1 }, 'inquiry'), true);
  assert.equal(overrideAppliesTo({ advertising_enabled: 1, inquiry_enabled: 0 }, 'inquiry'), false);
  assert.equal(overrideAppliesTo({ advertising_enabled: 0, inquiry_enabled: 0 }, 'advertising', { page: true }), true);
  assert.equal(overrideAppliesTo({ advertising_enabled: 1, inquiry_enabled: 1 }, 'inquiry', { page: true }), true);
});

test('both audience flags false applies to neither audience but remains visible on page', () => {
  const row = { advertising_enabled: 0, inquiry_enabled: 0 };

  assert.equal(overrideAppliesTo(row, 'advertising'), false);
  assert.equal(overrideAppliesTo(row, 'inquiry'), false);
  assert.equal(overrideAppliesTo(row, 'advertising', { page: true }), true);
});

test('stale lease override is excluded from audiences and marked for page', () => {
  const stale = { advertising_enabled: 1, inquiry_enabled: 1, lease_id: '501', current_lease_id: '502' };

  assert.equal(leaseChangedForOverride(stale), true);
  assert.equal(overrideAppliesTo(stale, 'advertising'), false);
  assert.equal(overrideAppliesTo(stale, 'inquiry'), false);
  assert.equal(overrideAppliesTo(stale, 'advertising', { page: true }), true);
  assert.equal(manualRow({ ...stale, lease_changed: true }).lease_changed, true);
});

test('pickVacancyRow keeps earlier manual availability over later lease availability', () => {
  const manual = manualRow({ available_from: '2026-09-01' });
  const lease = normalRow({ end_date: '2026-10-14' });

  assert.equal(pickVacancyRow(manual, lease), manual);
});

test('pickVacancyRow lets lease win when manual availability is not earlier', () => {
  const manual = manualRow({ available_from: '2026-10-20' });
  const lease = normalRow({ end_date: '2026-10-14' });

  assert.equal(pickVacancyRow(manual, lease), lease);
});

test('pickVacancyRow lets already-vacant lease rows win over manual rows', () => {
  const manual = manualRow({ available_from: '2026-09-01' });
  const lease = normalRow({ status: 'vacant', tier: 1, days_left: -4, end_date: null });

  assert.equal(pickVacancyRow(manual, lease), lease);
});

test('pickVacancyRow never emits both rows for one unit', () => {
  const cases = [
    [manualRow({ available_from: '2026-09-01' }), normalRow({ end_date: '2026-10-14' })],
    [manualRow({ available_from: '2026-10-20' }), normalRow({ end_date: '2026-10-14' })],
    [manualRow({ available_from: '2026-09-01' }), normalRow({ status: 'vacant', tier: 1, end_date: null })],
  ];

  for (const [manual, lease] of cases) {
    const picked = pickVacancyRow(manual, lease);
    assert.equal(Array.isArray(picked), false);
    assert.equal([manual, lease].includes(picked), true);
  }
});

test('default manual vacancy expiry is three days after availability', () => {
  assert.equal(deriveDefaultVacancyExpiry('2026-10-15'), '2026-10-18');
  assert.equal(deriveDefaultVacancyExpiry('2026-10-30'), '2026-11-02');
});

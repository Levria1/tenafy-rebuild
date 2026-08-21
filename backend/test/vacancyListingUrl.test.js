const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { manualVacancyToRow, vacancyToPublicShape } = require('../src/utils/advertisingPlan');

// ---------------------------------------------------------------------------
// listing_url on /vacancies.
//
// The endpoint published null for every row while /units/{id} returned a real
// URL for the same unit. The column was never missing from the database and
// never missing from the shaping function: all three queries behind
// computeVacancies already SELECT u.listing_url, and vacancyToPublicShape
// already reads `row?.listing_url ?? null`. It was dropped by the three
// row-mapping functions in between — fetched, carried most of the way, and lost
// at the last step, on every path.
//
// That shape of bug is why the assertions below check the JOIN between the
// stages rather than either stage alone. A test of vacancyToPublicShape in
// isolation passes today and passed throughout the outage.
// ---------------------------------------------------------------------------

const UNIT_ROW = {
  unit_id: '101',
  unit_name: '5A',
  rent: 12000,
  rent_price_min: 11800,
  rent_price_max: 12500,
  listing_url: 'https://taneresidence.com/product/mongkok-studio-5a/',
  property_id: '301',
  property_name: 'Mong Kok',
  street_address: '95 Tung Choi Street',
  district: 'Mong Kok',
  city: 'Kowloon',
};

const OVERRIDE = { available_from: '2026-11-01' };

test('manual rows carry listing_url through to the public shape', () => {
  const row = manualVacancyToRow(OVERRIDE, UNIT_ROW, '2026-10-01');
  assert.equal(row.listing_url, UNIT_ROW.listing_url, 'dropped by the row map');

  const shaped = vacancyToPublicShape(row);
  assert.equal(shaped.listing_url, UNIT_ROW.listing_url, 'dropped by the public shape');
});

test('a unit with no listing yields null, never undefined', () => {
  // undefined disappears from JSON entirely, so the key would vanish from the
  // response rather than reading as "no listing". A consumer cannot tell the
  // difference between an absent key and an endpoint that forgot the field —
  // which is precisely how this went unnoticed.
  const row = manualVacancyToRow(OVERRIDE, { ...UNIT_ROW, listing_url: undefined }, '2026-10-01');
  assert.equal(row.listing_url, null);

  const shaped = vacancyToPublicShape(row);
  assert.equal(shaped.listing_url, null);
  assert.ok('listing_url' in shaped, 'the key must be present even when empty');
});

test('an empty-string listing_url normalises to null rather than publishing ""', () => {
  const row = manualVacancyToRow(OVERRIDE, { ...UNIT_ROW, listing_url: '' }, '2026-10-01');
  assert.equal(row.listing_url, null);
});

// --- Tripwires for the two inline maps -------------------------------------
// expiringRows and vacantRows are built inside computeVacancies and need a live
// pool, so they cannot be called here. These pin the field in each map body.
// They catch removal of the line, not a line that is present but wrong.

const advertisingSrc = () =>
  fs.readFileSync(path.join(__dirname, '../src/routes/advertising.js'), 'utf8');

function mapBody(src, startMarker) {
  const from = src.indexOf(startMarker);
  assert.ok(from !== -1, `map not found: ${startMarker} — computeVacancies was restructured`);
  // Slice to the end of that object literal's property_id line, which every one
  // of these maps has. Bounded so a neighbouring map cannot satisfy the check.
  const to = src.indexOf('property_id:', from);
  assert.ok(to !== -1 && to > from, 'property_id not found inside the map body');
  return src.slice(from, to);
}

test('tripwire: the expiring map carries listing_url', () => {
  const body = mapBody(advertisingSrc(), 'const expiringRows = expiring.map(');
  assert.ok(/listing_url:/.test(body), 'expiring vacancies would publish no listing');
});

test('tripwire: the vacant map carries listing_url', () => {
  const body = mapBody(advertisingSrc(), 'const vacantRows = vacant.map(');
  assert.ok(/listing_url:/.test(body), 'vacant units would publish no listing');
});

test('tripwire: the beyond-horizon map carries listing_url', () => {
  // A FOURTH public path, found only because the count assertion below disagreed
  // with the three this fix was scoped to. /vacancies serves it when a requested
  // date is past the booking horizon, and it has its own query and its own row
  // map — so it had the identical defect and would have been left behind.
  const body = mapBody(advertisingSrc(), 'async function findBeyondHorizonNrVacancies');
  assert.ok(/listing_url:/.test(body), 'beyond-horizon vacancies would publish no listing');
});

test('tripwire: every query that maps listing_url still SELECTs it', () => {
  // If a query stops selecting it, the maps above go quietly null again and the
  // per-map tripwires all still pass. Four paths: expiring, vacant, manual,
  // beyond-horizon. This count is the thing that caught the fourth one.
  const src = advertisingSrc();
  const selects = src.match(/u\.listing_url AS listing_url/g) || [];
  assert.equal(selects.length, 4,
    `expected 4 queries selecting listing_url (expiring, vacant, manual, beyond-horizon), found ${selects.length}`);
});

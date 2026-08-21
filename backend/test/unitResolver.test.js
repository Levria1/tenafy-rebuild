const test = require('node:test');
const assert = require('node:assert');
const { scoreUnits, optionsText, normalizeFloorUnit, _editDistance, _unitCore } = require('../src/services/unitResolver');

// A small fixture: two properties, a stray-suffix unit, and a colliding "6A".
const UNITS = [
  { id: '1', name: '6A Test', property_id: 'p1', property_name: 'Mong Kok', marketable: true },
  { id: '2', name: '5A', property_id: 'p1', property_name: 'Mong Kok', marketable: true },
  { id: '3', name: '4A', property_id: 'p2', property_name: 'Jervois', marketable: false },
  { id: '4', name: '6A', property_id: 'p2', property_name: 'Jervois', marketable: true },
  { id: '5', name: '12B', property_id: 'p3', property_name: 'Nam Pak Hong', marketable: true },
];
const R = (q) => scoreUnits(q, UNITS);

const FIVE_5B_UNITS = [
  { id: 'gb-5b', name: '5B', property_id: 'gb', property_name: "Gilman's Bazaar", district: 'Central', city: 'Hong Kong', marketable: true },
  { id: 'mercer-5b', name: '5B', property_id: 'mercer', property_name: 'Mercer', district: 'Sheung Wan', city: 'Hong Kong', marketable: true },
  { id: 'hollywood-5b', name: '5B', property_id: 'hollywood', property_name: 'Hollywood', district: 'Sheung Wan', city: 'Hong Kong', marketable: true },
  { id: 'mk-5b', name: '5B', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Kowloon', marketable: true },
  { id: 'poplar-5b', name: '5B', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', city: 'Kowloon', marketable: true },
];

test('resolver: confident match despite a stray "Test" suffix (no rename)', () => {
  const r = R('mongkok 6a');
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, '1');
  assert.equal(r.match.label, 'Mong Kok 6A Test');
});

test('resolver: property initials alias ("mk 6a")', () => {
  const r = R('mk 6a');
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, '1');
});

test('resolver: case- and space-insensitive ("MongKok 6A")', () => {
  assert.equal(R('MongKok 6A').status, 'confident');
  assert.equal(R('  mong  kok   6a ').match.unit_id, '1');
});

test('resolver: tolerates a light property typo ("mongok 6a")', () => {
  assert.equal(R('mongok 6a').status, 'confident');
});

test('resolver: property only → list marketable units at that property', () => {
  const r = R('mongkok');
  assert.equal(r.status, 'property_only');
  assert.deepEqual(r.candidates.map(c => c.unit_id).sort(), ['1', '2']);
});

test('resolver: same unit token across properties → ambiguous, lists both', () => {
  const r = R('6a');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map(c => c.unit_id).sort(), ['1', '4']);
});

test('resolver: two distinct units named → multi_unit (escalate to staff)', () => {
  const r = R('mongkok 6a 5a');
  assert.equal(r.status, 'multi_unit');
});

test('resolver: single unit token colliding across properties stays ambiguous (not multi_unit)', () => {
  // "6a" matches 6A at two buildings but is ONE unit intent → ambiguous, not multi.
  assert.equal(R('6a').status, 'ambiguous');
});

test('resolver: unrecognisable → none', () => {
  assert.equal(R('the corner flat').status, 'none');
  assert.equal(R('').status, 'none');
});

test('resolver: multi-word property with initials ("nph 12b")', () => {
  const r = R('nph 12b');
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, '5');
});

test('resolver: ambiguity candidate list prefers marketable, else falls back', () => {
  // "4a" exists only at Jervois (non-marketable) → still offered (fallback), not dropped.
  const r = R('4a');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map(c => c.unit_id), ['3']);
});

test('optionsText: numbered list', () => {
  assert.equal(
    optionsText([{ label: 'Mong Kok 6A' }, { label: 'Jervois 4B' }]),
    '1) Mong Kok 6A\n2) Jervois 4B'
  );
});

test('helpers: editDistance bounded + unitCore strips suffix', () => {
  assert.equal(_editDistance('mongok', 'mongkok', 1), 1);
  assert.equal(_editDistance('abc', 'xyz', 1), 2); // early-exits above max
  assert.equal(_unitCore('6A Test'), '6a');
  assert.equal(_unitCore('Rooftop/Stairway'), 'rooftop');
});

test('helpers: unitCore skips a leading generic word ("Unit 22" -> "22")', () => {
  assert.equal(_unitCore('Unit 22'), '22');
  assert.equal(_unitCore('Flat 3B'), '3b');
  assert.equal(_unitCore('Unit 3 B'), '3b'); // multi-token tail kept (no 3A/3B collision)
  assert.equal(_unitCore('6A'), '6a');       // number+letter unaffected
  assert.equal(_unitCore('Unit'), 'unit');   // only a generic word → keep it
});

test('resolver: "Unit N" names resolve on the number (single confident + multi escalates)', () => {
  const U = [
    { id: 'a', name: 'Unit 22', property_id: 'p9', property_name: 'Pearl City', marketable: true },
    { id: 'b', name: 'Unit 23', property_id: 'p9', property_name: 'Pearl City', marketable: true },
  ];
  assert.equal(scoreUnits('pearl city unit 22', U).status, 'confident');
  assert.equal(scoreUnits('pearl city unit 22 and 23', U).status, 'multi_unit');
});

test('resolver: district signal resolves the live Central 5B negotiation', () => {
  // This is the negotiation that stalled in RESOLVE_UNIT on 2026-08-10.
  const r = scoreUnits('central studio 5b', FIVE_5B_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'gb-5b');
  assert.equal(r.match.label, "Gilman's Bazaar 5B");
});

test('resolver: district signal narrows Sheung Wan 5B to the two matching properties', () => {
  const r = scoreUnits('sheung wan 5b', FIVE_5B_UNITS);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(
    r.candidates.map(c => c.property_name).sort(),
    ['Hollywood', 'Mercer']
  );
});

test('resolver: city signal narrows Kowloon 5B to Mong Kok and Poplar', () => {
  const r = scoreUnits('kowloon 5b', FIVE_5B_UNITS);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(
    r.candidates.map(c => c.property_name).sort(),
    ['Mong Kok', 'Poplar']
  );
});

test('resolver: property name beats a conflicting district signal', () => {
  const U = [
    { id: 'nph-12b', name: '12B', property_id: 'nph', property_name: 'Nam Pak Hong', district: 'Sheung Wan', city: 'Hong Kong', marketable: true },
    { id: 'central-12b', name: '12B', property_id: 'central', property_name: 'Other', district: 'Central', city: 'Hong Kong', marketable: true },
  ];
  const r = scoreUnits('pak central 12b', U);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'nph-12b');
});

test('resolver: units with no district or city stay backwards-compatible', () => {
  const withoutLocation = FIVE_5B_UNITS.map(({ district, city, ...u }) => u);
  const r = scoreUnits('central studio 5b', withoutLocation);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(
    r.candidates.map(c => c.unit_id).sort(),
    ['gb-5b', 'hollywood-5b', 'mercer-5b', 'mk-5b', 'poplar-5b']
  );
});

test('resolver: null empty and short location values contribute nothing', () => {
  const U = [
    { id: 'short-1', name: '5B', property_id: 's1', property_name: 'Alpha', district: null, city: 'HK', marketable: true },
    { id: 'short-2', name: '5B', property_id: 's2', property_name: 'Beta', district: '', city: '', marketable: true },
    { id: 'short-3', name: '5B', property_id: 's3', property_name: 'Gamma', district: 'NT', city: null, marketable: true },
  ];
  const r = scoreUnits('hk 5b', U);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map(c => c.unit_id).sort(), ['short-1', 'short-2', 'short-3']);
});

test('resolver: district matching property display name does not double-count', () => {
  const r = scoreUnits('mong kok 5b', FIVE_5B_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'mk-5b');
});

const REAL_PROPERTY_UNITS = [
  { id: 'pearl-b6-22', name: 'Unit 22', property_id: 'pearl-b6', property_name: '12-B6 Pearl City Mansion', district: 'Causeway Bay', city: 'Hong Kong', street_address: '12-B6 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'pearl-b6-7a', name: '7A', property_id: 'pearl-b6', property_name: '12-B6 Pearl City Mansion', district: 'Causeway Bay', city: 'Hong Kong', street_address: '12-B6 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'pearl-c1-22', name: 'Unit 22', property_id: 'pearl-c1', property_name: '12-C1 Pearl City Mansion', district: 'Causeway Bay', city: 'Hong Kong', street_address: '12-C1 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'pearl-c1-7a', name: '7A', property_id: 'pearl-c1', property_name: '12-C1 Pearl City Mansion', district: 'Causeway Bay', city: 'Hong Kong', street_address: '12-C1 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'lai-yuen-2a', name: '2A', property_id: 'lai-yuen', property_name: '13B Lai Yuen Apartments', district: 'Causeway Bay', city: 'Hong Kong', street_address: '56-61 Russell Street', marketable: true },
  { id: 'lai-yuen-7a', name: '7A', property_id: 'lai-yuen', property_name: '13B Lai Yuen Apartments', district: 'Causeway Bay', city: 'Hong Kong', street_address: '56-61 Russell Street', marketable: true },
  { id: 'cleverly-1a', name: '1A', property_id: 'cleverly', property_name: 'Cleverly', district: 'Sheung Wan', city: 'Hong Kong', street_address: '8 Cleverly Street, Sheung Wan', marketable: true },
  { id: 'cleverly-5b', name: '5B', property_id: 'cleverly', property_name: 'Cleverly', district: 'Sheung Wan', city: 'Hong Kong', street_address: '8 Cleverly Street, Sheung Wan', marketable: true },
  { id: 'fuk-lo-tsun-7a', name: '7A', property_id: 'fuk-lo-tsun', property_name: 'Fuk Lo Tsun', district: 'Kowloon City', city: 'Hong Kong', street_address: '23 Fuk Lo Tsun Road, Kowloon City', marketable: true },
  { id: 'gilmans-5b', name: '5B', property_id: 'gilmans', property_name: "Gilman's Bazaar", district: 'Central', city: 'Hong Kong', street_address: "36 Gilman's Bazaar", marketable: true },
  { id: 'hillier-5b', name: '5B', property_id: 'hillier', property_name: 'Hillier', district: 'Sheung Wan', city: 'Hong Kong', street_address: '18 Hillier Street, Sheung Wan', marketable: true },
  { id: 'hollywood-5b', name: '5B', property_id: 'hollywood', property_name: 'Hollywood', district: 'Sheung Wan', city: 'Hong Kong', street_address: '84 Hollywood Road, Sheung Wan', marketable: true },
  { id: 'jardine-7a', name: '7A', property_id: 'jardine', property_name: 'Jardine', district: 'Causeway Bay', city: 'Hong Kong', street_address: "41-43 Jardine's Bazaar, Causeway Bay", marketable: true },
  { id: 'jervois-5b', name: '5B', property_id: 'jervois', property_name: 'Jervois', district: 'Sheung Wan', city: 'Hong Kong', street_address: '3 Jervois Street, Sheung Wan', marketable: true },
  { id: 'mercer-5b', name: '5B', property_id: 'mercer', property_name: 'Mercer', district: 'Sheung Wan', city: 'Hong Kong', street_address: '10 Mercer Street, Sheung Wan', marketable: true },
  { id: 'mong-kok-5a', name: '5A', property_id: 'mong-kok', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'nam-pak-hong-7a', name: '7A', property_id: 'nam-pak-hong', property_name: 'Nam Pak Hong', district: 'Sheung Wan', city: 'Hong Kong', street_address: 'Nam Pak Hong Building, 24 Bonham Strand West, Sheung Wan', marketable: true },
  { id: 'nam-pak-hong-5b', name: '5B', property_id: 'nam-pak-hong', property_name: 'Nam Pak Hong', district: 'Sheung Wan', city: 'Hong Kong', street_address: 'Nam Pak Hong Building, 24 Bonham Strand West, Sheung Wan', marketable: true },
  { id: 'office-8', name: '8', property_id: 'office', property_name: 'Office', district: null, city: 'Hong Kong', street_address: '21/F Unit B, Man On Commercial Building', marketable: true },
  { id: 'po-thai-3a', name: '3A', property_id: 'po-thai', property_name: 'Po Thai', district: 'Sheung Wan', city: 'Hong Kong', street_address: '9 Possession Street', marketable: true },
  { id: 'poplar-5b', name: '5B', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', city: 'Hong Kong', street_address: '23 Poplar Street', marketable: true },
  { id: 'tai-yuen-7a', name: '7A', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', district: 'Wan Chai', city: 'Hong Kong', street_address: '15 Tai Yuen St, Wan Chai, Hong Kong', marketable: true },
  { id: 'test-property-1', name: '1', property_id: 'test-property', property_name: 'Test Property', district: null, city: 'Hong Kong', street_address: 'Kwai Chung Road - 1', marketable: true },
  { id: 'test-property-2', name: '2', property_id: 'test-property-2', property_name: 'Test Property 2', district: null, city: 'Hong Kong', street_address: 'Kwai Chung Road - 1', marketable: true },
];

test('resolver: street address token resolves Nam Pak Hong 7A from Bonham Strand', () => {
  // This is the bug that motivated the change: the street was previously not a property signal.
  const r = scoreUnits('7A Bonham Strand West', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'nam-pak-hong-7a');
});

test('resolver: address-only Russell token resolves Lai Yuen 2A', () => {
  const r = scoreUnits('russell 2a', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'lai-yuen-2a');
});

test('resolver: address-only Tung Choi tokens resolve Mong Kok 5A', () => {
  const r = scoreUnits('tung choi 5a', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'mong-kok-5a');
});

test('resolver: street number is never property identity', () => {
  const r = scoreUnits('8 Cleverly Street', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'property_only');
  assert.deepEqual(
    r.candidates.map(c => c.unit_id).sort(),
    ['cleverly-1a', 'cleverly-5b']
  );
});

test('resolver: generic address words alone match nothing', () => {
  assert.equal(scoreUnits('street', REAL_PROPERTY_UNITS).status, 'none');
  assert.equal(scoreUnits('building', REAL_PROPERTY_UNITS).status, 'none');
  assert.equal(scoreUnits('road', REAL_PROPERTY_UNITS).status, 'none');
});

test('resolver: shared Paterson address remains ambiguous across both Pearl City properties', () => {
  const r = scoreUnits('paterson 22', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(
    r.candidates.map(c => c.unit_id).sort(),
    ['pearl-b6-22', 'pearl-c1-22']
  );
});

test('resolver: property name match still beats location-only Sheung Wan 5B matches', () => {
  const r = scoreUnits('mercer 5b', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'mercer-5b');
});

test('resolver: Nam Pak Hong name match is unchanged', () => {
  const r = scoreUnits('nam pak hong 7a', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'nam-pak-hong-7a');
});

test('resolver: null and empty street addresses contribute no score and do not crash', () => {
  const U = [
    { id: 'null-street', name: '1A', property_id: 'null-street', property_name: 'Null Street', district: null, city: null, street_address: null, marketable: true },
    { id: 'empty-street', name: '1A', property_id: 'empty-street', property_name: 'Empty Street', district: null, city: null, street_address: '', marketable: true },
  ];
  const r = scoreUnits('bonham 1a', U);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map(c => c.unit_id).sort(), ['empty-street', 'null-street']);
});

const HK_FLOOR_UNITS = [
  { id: 'mk-1a', name: '1A', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'mk-1b', name: '1B', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'mk-1c', name: '1C', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'mk-1d', name: '1D', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'mk-2b', name: '2B', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'mk-5d', name: '5D', property_id: 'mk', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'mercer-5b', name: '5B', property_id: 'mercer', property_name: 'Mercer', district: 'Sheung Wan', city: 'Hong Kong', street_address: '10 Mercer Street, Sheung Wan', marketable: true },
  { id: 'hollywood-5b', name: '5B', property_id: 'hollywood', property_name: 'Hollywood', district: 'Sheung Wan', city: 'Hong Kong', street_address: '84 Hollywood Road, Sheung Wan', marketable: true },
];

test('resolver: Hong Kong floor and flat notation resolves expected live-style outcomes', () => {
  const cases = [
    ['Mong Kok 1/F Studio C', 'confident', 'mk-1c'],
    ['Mong Kok 1/F C', 'confident', 'mk-1c'],
    ['Mongkok 1/F Flat C', 'confident', 'mk-1c'],
    ['Mong Kok 5/F D', 'confident', 'mk-5d'],
    ['Mong Kok 2/F B', 'confident', 'mk-2b'],
    ['Sheung Wan 5/F Flat B', 'ambiguous', null],
  ];

  for (const [query, status, unitId] of cases) {
    const r = scoreUnits(query, HK_FLOOR_UNITS);
    assert.equal(r.status, status, query);
    if (unitId) assert.equal(r.match.unit_id, unitId, query);
  }

  assert.deepEqual(
    scoreUnits('Sheung Wan 5/F Flat B', HK_FLOOR_UNITS).candidates.map(c => c.unit_id).sort(),
    ['hollywood-5b', 'mercer-5b']
  );
});

test('resolver: floor marker and letter are consumed, not appended', () => {
  const U = [
    { id: 'trap-1c', name: '1C', property_id: 'trap', property_name: 'Trap Tower', district: 'Mong Kok', city: 'Hong Kong', street_address: '1 Trap Street', marketable: true },
    { id: 'other-1', name: 'Unit 1', property_id: 'other', property_name: 'Other House', district: 'Central', city: 'Hong Kong', street_address: '1 Other Street', marketable: true },
  ];

  const r = scoreUnits('Trap Tower 1/F Studio C', U);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'trap-1c');
});

test('resolver: article guard keeps non-final a and i as ordinary words', () => {
  const U = [
    { id: 'article-1a', name: '1A', property_id: 'article', property_name: 'Article House', district: 'Mong Kok', city: 'Hong Kong', street_address: '1 Article Street', marketable: true },
    { id: 'article-1i', name: '1I', property_id: 'article', property_name: 'Article House', district: 'Mong Kok', city: 'Hong Kong', street_address: '1 Article Street', marketable: true },
  ];

  const article = scoreUnits('Article House 1/F a nice flat', U);
  assert.notEqual(article.status, 'confident');
  assert.equal(article.match, null);

  const pronoun = scoreUnits('Article House 1/F i want it', U);
  assert.notEqual(pronoun.status, 'confident');
  assert.equal(pronoun.match, null);

  const unit = scoreUnits('Article House 1/F Studio A', U);
  assert.equal(unit.status, 'confident');
  assert.equal(unit.match.unit_id, 'article-1a');

  const unitI = scoreUnits('Article House 1/F Studio I', U);
  assert.equal(unitI.status, 'confident');
  assert.equal(unitI.match.unit_id, 'article-1i');
});

test('resolver: floor-unit normalization is additive for existing confident queries', () => {
  const U = [
    { id: 'spread-3a', name: '3A', property_id: 'spread', property_name: 'Spread House', district: 'Central', city: 'Hong Kong', street_address: '3 Spread Street', marketable: true },
    { id: 'spread-22', name: 'Unit 22', property_id: 'spread', property_name: 'Spread House', district: 'Central', city: 'Hong Kong', street_address: '3 Spread Street', marketable: true },
    { id: 'spread-3b', name: 'Flat 3B', property_id: 'spread', property_name: 'Spread House', district: 'Central', city: 'Hong Kong', street_address: '3 Spread Street', marketable: true },
    { id: 'spread-room-c', name: 'Room C', property_id: 'spread', property_name: 'Spread House', district: 'Central', city: 'Hong Kong', street_address: '3 Spread Street', marketable: true },
    { id: 'spread-floor-room', name: '3/F Unit 1 (Room A and Room B)', property_id: 'spread', property_name: 'Spread House', district: 'Central', city: 'Hong Kong', street_address: '3 Spread Street', marketable: true },
    { id: 'spread-6a-test', name: '6A Test', property_id: 'spread', property_name: 'Spread House', district: 'Central', city: 'Hong Kong', street_address: '3 Spread Street', marketable: true },
  ];

  // Outcomes are PINNED to what the resolver returned before floor+unit
  // normalization existed. Comparing scoreUnits(q) against
  // scoreUnits(normalizeFloorUnit(q)) would prove only that normalization is
  // idempotent — scoreUnits already normalizes internally — so such a test
  // cannot fail on a regression. These literals can.
  //
  // The load-bearing row is the unit whose NAME contains a floor marker:
  // rewriting a query that legitimately reads "3/F Unit 1 (Room A and Room B)"
  // would silently retarget it at "Flat 3B". Relaxing the one-generic-word gap
  // rule does exactly that, and turns this red.
  const expected = [
    ['Spread House 3A', 'ambiguous', null],
    ['Spread House Unit 22', 'confident', 'spread-22'],
    ['Spread House Flat 3B', 'ambiguous', null],
    ['Spread House Room C', 'confident', 'spread-room-c'],
    ['Spread House 3/F Unit 1 (Room A and Room B)', 'confident', 'spread-floor-room'],
    ['Spread House 6A Test', 'confident', 'spread-6a-test'],
  ];
  assert.equal(expected.length, U.length);
  for (const [query, status, unitId] of expected) {
    const r = scoreUnits(query, U);
    assert.equal(r.status, status, query);
    assert.equal(r.match && r.match.unit_id, unitId, query);
  }
});

test('resolver: query reports the original text, not the floor-unit rewrite', () => {
  const r = scoreUnits('Mong Kok 1/F Studio C', HK_FLOOR_UNITS);
  assert.equal(r.status, 'confident');
  assert.equal(r.query, 'mong kok 1 f studio c');
});

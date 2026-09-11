const test = require('node:test');
const assert = require('node:assert');
const { scoreUnits, candidateList, optionsText, normalizeFloorUnit, collapseThousands, dropDecimalFraction, _editDistance, _unitCore } = require('../src/services/unitResolver');

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

test('resolver: property-only candidate order follows typed property words, not input order', () => {
  const U = [
    { id: 'tai-25', name: 'Unit 25', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'lai-103', name: 'Unit 103', property_id: 'lai-yuen', property_name: '13B Lai Yuen Apartments', marketable: true },
  ];

  for (const units of [U, [...U].reverse()]) {
    const tai = scoreUnits('tai yuen', units);
    assert.equal(tai.status, 'property_only');
    assert.match(tai.candidates[0].label, /Tai Yuen/);

    const lai = scoreUnits('lai yuen', units);
    assert.equal(lai.status, 'property_only');
    assert.match(lai.candidates[0].label, /Lai Yuen/);
  }
});

test('resolver: property-only candidates order by soonest availability within a building', () => {
  const U = [
    { id: 'open', name: '4A', property_id: 'available', property_name: 'Available House', marketable: true, vacant_now: false, occupied_until: null },
    { id: 'later', name: '2A', property_id: 'available', property_name: 'Available House', marketable: true, vacant_now: false, occupied_until: '2026-12-15' },
    { id: 'vacant', name: '3A', property_id: 'available', property_name: 'Available House', marketable: true, vacant_now: true, occupied_until: null },
    { id: 'earlier', name: '1A', property_id: 'available', property_name: 'Available House', marketable: true, vacant_now: false, occupied_until: '2026-09-01' },
  ];

  const r = scoreUnits('available house', U);
  assert.equal(r.status, 'property_only');
  assert.deepEqual(r.candidates.map(c => c.unit_id), ['vacant', 'earlier', 'later', 'open']);
});

test('resolver: property relevance beats availability across shared building words', () => {
  const U = [
    { id: 'ly-103', name: 'Unit 103', property_id: 'lai-yuen', property_name: '13B Lai Yuen Apartments', marketable: true, vacant_now: true, occupied_until: null },
    { id: 'ty-25', name: 'Unit 25', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true, vacant_now: false, occupied_until: '2027-12-31' },
    { id: 'ty-10', name: 'Unit 10', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true, vacant_now: false, occupied_until: '2027-11-30' },
  ];

  const r = scoreUnits('tai yuen', U);
  assert.equal(r.status, 'property_only');
  const firstLaiYuen = r.candidates.findIndex(c => c.property_id === 'lai-yuen');
  const lastTaiYuen = r.candidates.map(c => c.property_id).lastIndexOf('tai-yuen');
  assert.ok(firstLaiYuen > lastTaiYuen);
});

test('resolver: fixtures without availability fields still sort by unit name', () => {
  const U = [
    { id: 'three', name: '3A', property_id: 'plain', property_name: 'Plain House', marketable: true },
    { id: 'one', name: '1A', property_id: 'plain', property_name: 'Plain House', marketable: true },
    { id: 'two', name: '2A', property_id: 'plain', property_name: 'Plain House', marketable: true },
  ];

  const r = scoreUnits('plain house', U);
  assert.equal(r.status, 'property_only');
  assert.deepEqual(r.candidates.map(c => c.unit_id), ['one', 'two', 'three']);
});

// The guard above is `if (!hasAvailability(a.u) || !hasAvailability(b.u)) return 0`.
// With every fixture bare it is redundant — both sides fall through to a null/null
// comparison anyway — so deleting it broke nothing and no test noticed. It only bites
// in the MIXED case: one unit carrying availability, another not. Ranking a
// known-vacant unit above a unit we know nothing about would be a guess dressed as
// data, so the comparison stays neutral and unit name decides. Pinned here because
// that is a decision, and because a guard nothing can break is not a guard.
test('resolver: a unit with availability does not outrank one with none', () => {
  const U = [
    { id: 'known-vacant', name: '9A', property_id: 'mix', property_name: 'Mixed House',
      marketable: true, vacant_now: true, occupied_until: null },
    { id: 'unknown', name: '1A', property_id: 'mix', property_name: 'Mixed House',
      marketable: true },
  ];

  const r = scoreUnits('mixed house', U);
  assert.equal(r.status, 'property_only');
  assert.deepEqual(r.candidates.map(c => c.unit_id), ['unknown', 'known-vacant'],
    'unit name decides when the two sides are not comparable');
});

test('resolver: candidate_count is true total and default cap does not trim current stock', () => {
  const U = Array.from({ length: 12 }, (_, i) => ({
    id: `stock-${i + 1}`,
    name: `Unit ${String(i + 1).padStart(2, '0')}`,
    property_id: 'stock',
    property_name: 'Stock House',
    marketable: true,
  }));

  const r = scoreUnits('stock house', U);
  assert.equal(r.status, 'property_only');
  assert.equal(r.candidates.length, 12);
  assert.equal(r.candidate_count, 12);

  const direct = candidateList(U.map(u => ({ u, s: { prop: 1, nameWordHits: 1 } })), 5);
  assert.equal(direct.candidates.length, 5);
  assert.equal(direct.candidate_count, 12);
});

test('resolver: candidate ordering is deterministic regardless of input order', () => {
  const U = [
    { id: 'b', name: '2B', property_id: 'order', property_name: 'Order House', marketable: true, vacant_now: false, occupied_until: '2026-10-01' },
    { id: 'a', name: '2A', property_id: 'order', property_name: 'Order House', marketable: true, vacant_now: false, occupied_until: '2026-10-01' },
    { id: 'c', name: '2C', property_id: 'order', property_name: 'Order House', marketable: true, vacant_now: false, occupied_until: '2026-11-01' },
  ];

  const forward = scoreUnits('order house', U).candidates.map(c => c.label);
  const reversed = scoreUnits('order house', [...U].reverse()).candidates.map(c => c.label);
  assert.deepEqual(forward, reversed);
});

test('resolver: weaker shared-name full match is not confident', () => {
  const U = [
    { id: 'ty-10f', name: '10/F', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'ty-25', name: 'Unit 25', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'ly-103', name: 'Unit 103', property_id: 'lai-yuen', property_name: '13B Lai Yuen Apartments', marketable: true },
    { id: 'ly-105', name: 'Unit 105', property_id: 'lai-yuen', property_name: '13B Lai Yuen Apartments', marketable: true },
  ];

  const weaker = scoreUnits('tai yuen unit 103', U);
  assert.notEqual(weaker.status, 'confident');
  assert.equal(weaker.match, null);
  assert.deepEqual(weaker.unmatched.map(u => u.text), ['103']);

  const betterNamed = scoreUnits('lai yuen unit 103', U);
  assert.equal(betterNamed.status, 'confident');
  assert.equal(betterNamed.match.unit_id, 'ly-103');

  const taiUnit = scoreUnits('tai yuen unit 25', U);
  assert.equal(taiUnit.status, 'confident');
  assert.equal(taiUnit.match.unit_id, 'ty-25');
});

test('resolver: single-property query ordering is unaffected', () => {
  const U = [
    { id: 'mk-6a', name: '6A', property_id: 'mong-kok', property_name: 'Mong Kok', marketable: true },
    { id: 'mk-5a', name: '5A', property_id: 'mong-kok', property_name: 'Mong Kok', marketable: true },
  ];
  const r = scoreUnits('mong kok', U);
  assert.equal(r.status, 'property_only');
  assert.ok(r.candidates.length > 0);
  assert.ok(r.candidates.every(c => c.property_name === 'Mong Kok'));

  const exact = scoreUnits('mong kok 5a', U);
  assert.equal(exact.status, 'confident');
  assert.equal(exact.match.unit_id, 'mk-5a');
});

test('resolver: same unit token across properties → ambiguous, lists both', () => {
  const r = R('6a');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map(c => c.unit_id).sort(), ['1', '4']);
});

test('resolver: two distinct units named → multi_unit with candidates', () => {
  const r = R('mongkok 6a 5a');
  assert.equal(r.status, 'multi_unit');
  assert.deepEqual(r.candidates.map(c => c.unit_id).sort(), ['1', '2']);
});

test('resolver: unrelated exact unit token does not turn one named unit into multi_unit', () => {
  const r = scoreUnits('Fuk Lo Tsun 3/F Unit 1', [
    {
      id: 'real',
      name: '3/F Unit 1 (Room A and Room B)',
      property_id: 'flt',
      property_name: 'Fuk Lo Tsun',
      marketable: true,
    },
    {
      id: 'test',
      name: 'Unit 1',
      property_id: 'test-property-2',
      property_name: 'Test Property 2',
      marketable: true,
    },
  ]);

  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'real');
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

test('resolver: district-only full match is unaffected by name-hit confidence guard', () => {
  const U = [
    { id: 'wc-9c', name: '9C', property_id: 'harbour', property_name: 'Harbour View', district: 'Wan Chai', city: 'Hong Kong', marketable: true },
    { id: 'central-9c', name: '9C', property_id: 'queens', property_name: 'Queens Place', district: 'Central', city: 'Hong Kong', marketable: true },
  ];
  const r = scoreUnits('wan chai 9c', U);
  assert.equal(r.status, 'confident');
  assert.equal(r.match.unit_id, 'wc-9c');
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

test('resolver: one address token no longer identifies a property by itself', () => {
  const r = scoreUnits('russell 2a', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.match, null);
  assert.deepEqual(r.candidates.map(c => c.unit_id), ['lai-yuen-2a']);
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
  // This read 'paterson 22' until 2026-08-24. The marker is now required because a
  // bare number is a price or a headcount far more often than a flat; the point of
  // THIS test is the cross-property ambiguity, so it keeps its scenario with the
  // number marked. The unmarked form is asserted below so the change stays visible.
  const r = scoreUnits('paterson unit 22', REAL_PROPERTY_UNITS);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(
    r.candidates.map(c => c.unit_id).sort(),
    ['pearl-b6-22', 'pearl-c1-22']
  );

  assert.notEqual(scoreUnits('paterson 22', REAL_PROPERTY_UNITS).status, 'confident');
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
    ['Spread House 3A', 'confident', 'spread-3a'],
    ['Spread House Unit 22', 'confident', 'spread-22'],
    ['Spread House Flat 3B', 'confident', 'spread-3b'],
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

const LIVE_SHAPE_CORES_9X = [
  ...'abcdefg'.split('').map(x => `1${x}`),
  ...'abcdefghijkl'.split('').map(x => `2${x}`),
  ...'abcd'.split('').map(x => `3${x}`),
  ...'abcd'.split('').map(x => `4${x}`),
  ...'abcd'.split('').map(x => `5${x}`),
  ...'abcdefg'.split('').map(x => `7${x}`),
  '8a', '8b',
];
const LIVE_SHAPE_UNITS = (() => {
  const units = [];
  let id = 1;
  const add = (property_id, property_name, district, city, street_address, name) => {
    units.push({ id: `live-${id++}`, name, property_id, property_name, district, city, street_address, marketable: true });
  };
  for (const core of LIVE_SHAPE_CORES_9X) add('mong-kok', 'Mong Kok', 'Mong Kok', 'Hong Kong', '95 Tung Choi Street, Mong Kok', core.toUpperCase());
  for (const core of LIVE_SHAPE_CORES_9X) add('jervois', 'Jervois', 'Sheung Wan', 'Hong Kong', '3 Jervois Street, Sheung Wan', core.toUpperCase());
  for (const core of LIVE_SHAPE_CORES_9X.slice(0, 21)) add('nam-pak-hong', 'Nam Pak Hong', 'Sheung Wan', 'Hong Kong', 'Nam Pak Hong Building, 24 Bonham Strand West, Sheung Wan', core.toUpperCase());

  for (const core of ['10', '11', '21', '25', '26']) add('tai-yuen', 'Tai Yuen Apartments', 'Wan Chai', 'Hong Kong', '15 Tai Yuen Street, Wan Chai', `Unit ${core}`);
  for (const core of ['22', '23']) add('pearl-city', 'Pearl City', 'Causeway Bay', 'Hong Kong', '22-36 Paterson Street, Causeway Bay', `Unit ${core}`);
  for (const core of ['22', '23', '59', '60']) add('pearl-city-c1', 'Pearl City Block C1', 'Causeway Bay', 'Hong Kong', '22-36 Paterson Street, Causeway Bay', `Unit ${core}`);
  add('lai-yuen', 'Lai Yuen Apartments', 'Causeway Bay', 'Hong Kong', '56-61 Russell Street, Causeway Bay', 'Unit 103');
  add('lai-yuen', 'Lai Yuen Apartments', 'Causeway Bay', 'Hong Kong', '56-61 Russell Street, Causeway Bay', 'Unit 105');
  add('fuk-lo-tsun', 'Fuk Lo Tsun', 'Kowloon City', 'Hong Kong', '23 Fuk Lo Tsun Road, Kowloon City', '3/F Unit 1 (Room A and Room B)');
  return units;
})();

function shapeOfUnitName(name) {
  return _unitCore(name).replace(/[0-9]/g, '9').replace(/[a-z]/g, 'x');
}

test('resolver fixture mirrors the live unit-core shape distribution', () => {
  const counts = LIVE_SHAPE_UNITS.reduce((acc, unit) => {
    const shape = shapeOfUnitName(unit.name);
    acc[shape] = (acc[shape] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { '9x': 101, '99': 11, '999': 2, '9': 1 });
});

test('resolver: purely numeric cores do not partial-match budget tokens', () => {
  const budget = scoreUnits('tai yuen, my budget is 25k', LIVE_SHAPE_UNITS);
  assert.notEqual(budget.status, 'confident');
  assert.notEqual(budget.match && budget.match.unit_name, 'Unit 25');

  // This line read 'tai yuen 25' and expected `confident` until 2026-08-24. A bare
  // number no longer names a numeric unit, because "my budget is 10,000" and "we are
  // 3 people" were confidently resolving to flats 10/F and 3/F. The old input is kept
  // below asserting its NEW result rather than deleted: the behaviour changed, and a
  // test that quietly swaps its input hides that from the next reader.
  const exact = scoreUnits('tai yuen unit 25', LIVE_SHAPE_UNITS);
  assert.equal(exact.status, 'confident');
  assert.equal(exact.match.label, 'Tai Yuen Apartments Unit 25');

  const unmarked = scoreUnits('tai yuen 25', LIVE_SHAPE_UNITS);
  assert.notEqual(unmarked.status, 'confident');
});

test('resolver: comma-grouped budgets do not create unmatched numeric flat reports', () => {
  const U = [
    { id: 'ty-10', name: 'Unit 10', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'ty-25', name: 'Unit 25', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'ty-103', name: 'Unit 103', property_id: 'tai-yuen', property_name: 'Tai Yuen Apartments', marketable: true },
  ];

  const unspaced = scoreUnits('tai yuen unit 103,105', U);
  assert.equal(unspaced.status, 'confident');
  assert.equal(unspaced.match.unit_id, 'ty-103');
  assert.deepEqual(unspaced.unmatched.map(u => u.text), ['105']);

  const spaced = scoreUnits('tai yuen unit 103, 105', U);
  assert.equal(spaced.status, 'confident');
  assert.equal(spaced.match.unit_id, 'ty-103');
  assert.deepEqual(spaced.unmatched.map(u => u.text), ['105']);

  assert.deepEqual(scoreUnits('tai yuen my budget is 25,000', U).unmatched, []);
  assert.deepEqual(scoreUnits('tai yuen budget 10 000', U).unmatched, []);
  assert.deepEqual(scoreUnits('tai yuen around HK$12,000 per month', U).unmatched, []);
  assert.deepEqual(scoreUnits('tai yuen my budget is 25k', U).unmatched, []);
  assert.deepEqual(scoreUnits('tai yuen 12,500.50 per month', U).unmatched, []);
  assert.deepEqual(scoreUnits('tai yuen 12,500 per month', U).unmatched, []);

  // This guards against suppressing any 3-digit token after another number: without
  // a comma, "105" is still a genuine second unit-like token and must be reported.
  assert.deepEqual(scoreUnits('tai yuen unit 103 105', U).unmatched.map(u => u.text), ['105']);
  assert.deepEqual(scoreUnits('tai yuen flat 10 105', U).unmatched.map(u => u.text), ['105']);
});

test('helpers: collapseThousands collapses repeated comma groups', () => {
  assert.equal(collapseThousands('1,234,567'), '1234567');
  assert.equal(collapseThousands('unit 103,105'), 'unit 103,105');
  assert.equal(collapseThousands('budget 25,000'), 'budget 25000');
});

test('helpers: dropDecimalFraction removes one- and two-digit decimal tails', () => {
  assert.equal(dropDecimalFraction('12500.50'), '12500');
  // Distances are non-unit quantities too; keeping the integer part cannot create
  // a unit match unless some other rule already decides the number is unit-like.
  assert.equal(dropDecimalFraction('3.5 km'), '3 km');
});

test('resolver: bare numeric tokens do not identify numeric-named units', () => {
  const U = [
    { id: 'n10', name: '10/F', property_id: 'ty', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'n3', name: '3/F', property_id: 'ty', property_name: 'Tai Yuen Apartments', marketable: true },
    { id: 'a', name: '6A', property_id: 'alpha', property_name: 'Alpha House', marketable: true },
  ];

  const budget = scoreUnits('tai yuen, my budget is 10,000', U);
  assert.notEqual(budget.status, 'confident');
  assert.equal(budget.match, null);

  const headcount = scoreUnits('tai yuen, we are 3 people', U);
  assert.notEqual(headcount.status, 'confident');

  const lease = scoreUnits('tai yuen for a 10 month lease', U);
  assert.notEqual(lease.status, 'confident');

  const beforeMarker = scoreUnits('tai yuen flat 10', U);
  assert.equal(beforeMarker.status, 'confident');
  assert.equal(beforeMarker.match.unit_id, 'n10');

  const afterMarker = scoreUnits('tai yuen 10/F', U);
  assert.equal(afterMarker.status, 'confident');
  assert.equal(afterMarker.match.unit_id, 'n10');

  // Deliberate: a bare number is usually a quantity, price or duration, so ask
  // which flat instead of confidently naming a numeric unit.
  assert.equal(scoreUnits('tai yuen 10', U).status, 'property_only');

  const letterNamed = scoreUnits('alpha house 6a', U);
  assert.equal(letterNamed.status, 'confident');
  assert.equal(letterNamed.match.unit_id, 'a');
});

test('resolver: alphanumeric partial matching is unchanged', () => {
  const U = [
    { id: 'a', name: '6A', property_id: 'alpha', property_name: 'Alpha House', marketable: true },
  ];
  // The partial rule needs a token of two characters or more, and always has. A bare
  // "6" is NOT a partial match for "6A" — pinning that here because it is easy to
  // misread the `// "6" ~ "6a"` comment on the rule as a promise that it is, and
  // loosening the length guard turns "2 bedrooms" into a question about flats 2A-2L.
  assert.equal(scoreUnits('alpha house 6', U).status, 'property_only');
  // Two characters or more still matches in both directions.
  assert.equal(scoreUnits('alpha house 6ab', U).match.unit_id, 'a');
  assert.equal(scoreUnits('alpha house 6a', U).match.unit_id, 'a');
});

test('resolver: single shared address word no longer creates a property match', () => {
  const r = scoreUnits('pearl city, my budget is 30k', LIVE_SHAPE_UNITS);
  assert.notEqual(r.status, 'confident');
  assert.ok(!r.candidates.some(c => c.property_id === 'fuk-lo-tsun'));
});

test('resolver: unmatched reports unit-like leftovers at the matched property', () => {
  const confident = scoreUnits('mong kok 6a 5a', LIVE_SHAPE_UNITS);
  assert.equal(confident.status, 'confident');
  assert.equal(confident.match.unit_name, '5A');
  assert.deepEqual(confident.unmatched.map(u => u.text), ['6a']);
  assert.ok(!confident.unmatched.some(u => u.text === '5a'));
  assert.deepEqual(confident.unmatched[0], {
    text: '6a',
    reason: 'unit_like_not_found',
    floor: '6',
    floor_units: [],
    floor_unit_count: 0,
  });

  const propertyOnly = scoreUnits('mong kok 6a', LIVE_SHAPE_UNITS);
  assert.equal(propertyOnly.status, 'property_only');
  assert.deepEqual(propertyOnly.unmatched.map(u => u.text), ['6a']);
});

const FLOOR_CONTEXT_UNITS = [
  { id: 'poplar-5a', name: '5A', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', city: 'Hong Kong', street_address: '23 Poplar Street', marketable: true },
  { id: 'poplar-5b', name: '5B', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', city: 'Hong Kong', street_address: '23 Poplar Street', marketable: true },
  { id: 'poplar-5c', name: '5C', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', city: 'Hong Kong', street_address: '23 Poplar Street', marketable: true },
  { id: 'poplar-5d', name: '5D', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', city: 'Hong Kong', street_address: '23 Poplar Street', marketable: true },
  { id: 'mong-kok-5a', name: '5A', property_id: 'mong-kok', property_name: 'Mong Kok', district: 'Mong Kok', city: 'Hong Kong', street_address: '95 Tung Choi Street, Mong Kok', marketable: true },
  { id: 'pearl-city-22', name: 'Unit 22', property_id: 'pearl-city', property_name: 'Pearl City', district: 'Causeway Bay', city: 'Hong Kong', street_address: '22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'pearl-city-23', name: 'Unit 23', property_id: 'pearl-city', property_name: 'Pearl City', district: 'Causeway Bay', city: 'Hong Kong', street_address: '22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'pearl-city-25', name: 'Unit 25', property_id: 'pearl-city', property_name: 'Pearl City', district: 'Causeway Bay', city: 'Hong Kong', street_address: '22-36 Paterson Street, Causeway Bay', marketable: true },
  { id: 'pearl-city-26', name: 'Unit 26', property_id: 'pearl-city', property_name: 'Pearl City', district: 'Causeway Bay', city: 'Hong Kong', street_address: '22-36 Paterson Street, Causeway Bay', marketable: true },
  ...'abcdefghi'.split('').map(letter => ({
    id: `big-5${letter}`,
    name: `5${letter.toUpperCase()}`,
    property_id: 'big-floor',
    property_name: 'Big Floor',
    district: 'Central',
    city: 'Hong Kong',
    street_address: '5 Big Street',
    marketable: true,
  })),
  { id: 'mercer-5a', name: '5A', property_id: 'mercer', property_name: 'Mercer', district: 'Sheung Wan', city: 'Hong Kong', street_address: '10 Mercer Street, Sheung Wan', marketable: true },
  { id: 'hollywood-5a', name: '5A', property_id: 'hollywood', property_name: 'Hollywood', district: 'Sheung Wan', city: 'Hong Kong', street_address: '84 Hollywood Road, Sheung Wan', marketable: true },
];

function assertNoNear(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(!Object.prototype.hasOwnProperty.call(value, 'near'));
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertNoNear(child);
}

test('resolver: unmatched floor context describes the selected building floor', () => {
  const r = scoreUnits('poplar 5e', FLOOR_CONTEXT_UNITS);
  assert.equal(r.status, 'property_only');
  assert.deepEqual(r.unmatched, [{
    text: '5e',
    reason: 'unit_like_not_found',
    floor: '5',
    floor_units: ['Poplar 5A', 'Poplar 5B', 'Poplar 5C', 'Poplar 5D'],
    floor_unit_count: 4,
  }]);
  assertNoNear(r);
});

test('resolver: unmatched floor context keeps an empty floor as meaningful', () => {
  const propertyOnly = scoreUnits('mong kok 6a', FLOOR_CONTEXT_UNITS);
  assert.equal(propertyOnly.status, 'property_only');
  assert.deepEqual(propertyOnly.unmatched, [{
    text: '6a',
    reason: 'unit_like_not_found',
    floor: '6',
    floor_units: [],
    floor_unit_count: 0,
  }]);

  const confident = scoreUnits('mong kok 6a 5a', FLOOR_CONTEXT_UNITS);
  assert.equal(confident.status, 'confident');
  assert.equal(confident.match.unit_id, 'mong-kok-5a');
  assert.deepEqual(confident.unmatched, propertyOnly.unmatched);
});

test('resolver: unmatched floor context is null for numeric tokens', () => {
  const r = scoreUnits('pearl city 24', FLOOR_CONTEXT_UNITS);
  assert.equal(r.status, 'property_only');
  assert.deepEqual(r.unmatched, [{
    text: '24',
    reason: 'unit_like_not_found',
    floor: null,
    floor_units: [],
    floor_unit_count: 0,
  }]);
});

test('resolver: unmatched floor unit list is capped but count remains total', () => {
  const r = scoreUnits('big floor 5q', FLOOR_CONTEXT_UNITS);
  assert.equal(r.status, 'property_only');
  assert.equal(r.unmatched[0].floor, '5');
  assert.deepEqual(r.unmatched[0].floor_units, [
    'Big Floor 5A',
    'Big Floor 5B',
    'Big Floor 5C',
    'Big Floor 5D',
    'Big Floor 5E',
    'Big Floor 5F',
    'Big Floor 5G',
    'Big Floor 5H',
  ]);
  assert.equal(r.unmatched[0].floor_unit_count, 9);
});

test('resolver: unmatched floor context is suppressed for multi-property ambiguity', () => {
  const r = scoreUnits('sheung wan 5e', FLOOR_CONTEXT_UNITS);
  assert.equal(r.status, 'property_only');
  assert.ok(new Set(r.candidates.map(c => c.property_id)).size > 1);
  assert.deepEqual(r.unmatched, [{
    text: '5e',
    reason: 'unit_like_not_found',
    floor: null,
    floor_units: [],
    floor_unit_count: 0,
  }]);
});

test('resolver: unmatched suppresses known non-unit domains', () => {
  assert.ok(!scoreUnits('unit 5a september', LIVE_SHAPE_UNITS).unmatched.some(u => u.text === 'september'));
  assert.deepEqual(scoreUnits('mong kok around 400 sqft', LIVE_SHAPE_UNITS).unmatched, []);
  assert.deepEqual(scoreUnits('tai yuen 12 months', LIVE_SHAPE_UNITS).unmatched, []);
  assert.ok(!scoreUnits('can i see 5a at 6pm', LIVE_SHAPE_UNITS).unmatched.some(u => u.text === '6pm'));
});

test('resolver: unmatched is always present and empty for none', () => {
  const r = scoreUnits('not about a flat', LIVE_SHAPE_UNITS);
  assert.equal(r.status, 'none');
  assert.deepEqual(r.unmatched, []);
});

// The unit load is a DB query, so this is a tripwire rather than a behavioural test: it pins the
// two status filters that decide which buildings can answer a customer at all. Dropping either one
// puts deactivated or removed properties back into live matching, where they both answer real
// enquiries and collide with real units — which is how a test building turned a straightforward
// booking into a multi_unit escalation.
test('resolver: the unit load excludes deactivated and deleted properties', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/unitResolver.js'), 'utf8');
  // Slice from WHERE so a nearby prose comment cannot satisfy these assertions — the
  // first version of this test passed a mutation for exactly that reason.
  const where = src.slice(src.indexOf('WHERE p.org_id'), src.indexOf('ORDER BY p.display_name'));
  assert.ok(/u\.active_status = 1/.test(where), 'inactive units must not resolve');
  assert.ok(/u\.deleted_at IS NULL/.test(where), 'deleted units must not resolve');
  assert.ok(/p\.deleted_at IS NULL/.test(where), 'units of deleted properties must not resolve');
  assert.ok(/p\.status = 1/.test(where), 'units of DEACTIVATED properties must not resolve');
});

// ─── a bare unit letter, once the building is known ──────────────────────────
//
// A prospect who writes "Bonham Strand West Studio A" has named the unit: Nam Pak
// Hong's flats are all on the 7th floor, so "A" can only be 7A. Before this the
// address matched and the letter did not, and the reply listed all seven units
// back to someone who had already said which one they wanted.
//
// Shaped on the live portfolio: Nam Pak Hong is single-floor, Mong Kok has an A on
// every floor, Po Thai's two units are hyphenated.
const LETTER_UNITS = [
  ...['7A', '7B', '7C', '7D', '7E', '7F', '7G'].map((n, i) => ({
    id: `nph-${i}`, name: n, property_id: 'nph', property_name: 'Nam Pak Hong',
    street_address: 'Nam Pak Hong Building, 24 Bonham Strand West', district: 'Sheung Wan', city: 'Hong Kong', marketable: true })),
  ...['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B', '5A', '5B'].map((n, i) => ({
    id: `mk-${i}`, name: n, property_id: 'mk', property_name: 'Mong Kok',
    street_address: '95 Tung Choi Street, Mong Kok', district: 'Mong Kok', city: 'Kowloon', marketable: true })),
  ...['3D-A', '3D-B'].map((n, i) => ({
    id: `pt-${i}`, name: n, property_id: 'pt', property_name: 'Po Thai',
    street_address: '9 Possession Street', district: 'Sheung Wan', city: 'Hong Kong', marketable: true })),
  ...['Unit 103', 'Unit 105'].map((n, i) => ({
    id: `ly-${i}`, name: n, property_id: 'ly', property_name: '13B Lai Yuen Apartments',
    street_address: ' 56-61 Russell Street', district: 'Causeway Bay', city: 'Hong Kong', marketable: true })),
  ...['1A', '1B', '2H', '3C'].map((n, i) => ({
    id: `flt-${i}`, name: n, property_id: 'flt', property_name: 'Fuk Lo Tsun',
    street_address: ' 23 Fuk Lo Tsun Road, Kowloon City', district: 'Kowloon City', city: 'Kowloon', marketable: true })),
];
const L = (q) => scoreUnits(q, LETTER_UNITS);
const labels = (r) => r.candidates.map(c => c.label);

test('letter: a single-floor building resolves a bare letter confidently', () => {
  const r = L('Hi, I am interested in Bonham Strand West Studio A. (ref: google)');
  assert.equal(r.status, 'confident');
  assert.equal(r.match.label, 'Nam Pak Hong 7A');
});

test('letter: marker-then-letter needs no capital ("studio a" is not an article)', () => {
  const r = L('nam pak hong studio a');
  assert.equal(r.status, 'confident');
  assert.equal(r.match.label, 'Nam Pak Hong 7A');
});

test('letter: a building with an A on every floor asks WHICH, listing only the A units', () => {
  const r = L('Tung Choi A unit');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(labels(r), ['Mong Kok 1A', 'Mong Kok 2A', 'Mong Kok 3A', 'Mong Kok 4A', 'Mong Kok 5A']);
});

// One letter is one request. Counting the five A-units it matches as five NAMED
// units sent a plain enquiry to staff as a multi-flat viewing request.
test('letter: matching several units on one letter is not a multi-unit request', () => {
  assert.equal(L('Tung Choi A unit').status, 'ambiguous');
  assert.equal(L('Tung Choi Street B unit').status, 'ambiguous');
  // naming two units by their own tokens still is one
  assert.equal(L('mong kok 5a 3b').status, 'multi_unit');
});

test('letter: "a" as the English article does not name unit A', () => {
  for (const q of [
    'Do you have a unit available at Bonham Strand West?',
    'A unit at Bonham Strand West please',   // sentence-initial capital is not a choice
    'TUNG CHOI A UNIT',                      // all caps: the capital says nothing
  ]) {
    const r = L(q);
    assert.equal(r.status, 'property_only', q);
    assert.equal(r.match, null, q);
  }
});

// b-z are never articles, so they need no capital.
test('letter: a non-article letter matches in any case', () => {
  const r = L('tung choi b unit');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(labels(r), ['Mong Kok 1B', 'Mong Kok 2B', 'Mong Kok 3B', 'Mong Kok 4B', 'Mong Kok 5B']);
});

// The letter is only a unit reference once a BUILDING is known. Without one it
// would match an A on every floor of every property; "not found" is the honest answer.
test('letter: a bare letter with no building named still resolves nothing', () => {
  const r = L('unit A');
  assert.equal(r.status, 'none');
  assert.equal(r.match, null);
});

// ─── one distinctive street name identifies a building ───────────────────────
test('address: a single street name resolves when the customer writes "Street"', () => {
  assert.deepEqual(labels(L('Russell Street')),
    ['13B Lai Yuen Apartments Unit 103', '13B Lai Yuen Apartments Unit 105']);
  assert.deepEqual(labels(L('Possession Street')), ['Po Thai 3D-A', 'Po Thai 3D-B']);
});

// "possession" is a tenancy word before it is a street. Without "Street" beside
// it, it must not drag the prospect to Po Thai.
test('address: a street word alone, used as ordinary English, matches nothing', () => {
  assert.equal(L('I need possession by 1 Oct').status, 'none');
});

// "kowloon" appears in exactly one property's ADDRESS (Fuk Lo Tsun Road, Kowloon
// City), so the single-token rule would hand the whole enquiry to that one
// building. It is a district, so it must not: naming a district matches every
// property in it, which is the pre-existing city/district behaviour and the right
// answer here.
test('address: a district name never singles out one building', () => {
  for (const q of ['anything in Kowloon?', 'Kowloon City Road']) {
    const r = L(q);
    assert.equal(r.match, null, q);
    const properties = new Set(r.candidates.map(c => c.property_name));
    assert.ok(properties.size > 1, `${q} narrowed to ${[...properties]}`);
    assert.ok(properties.has('Mong Kok') && properties.has('Fuk Lo Tsun'), q);
  }
});

// The letter of a FLOOR marker is not a unit letter: at Nam Pak Hong, whose units
// are 7A-7G, "3/F unit" must not come back as 7F.
test('letter: the "F" of a floor marker is not unit F', () => {
  const r = L('Nam Pak Hong 3/F unit');
  assert.equal(r.match, null);
  assert.equal(r.status, 'property_only');
});

// ─── a hyphen joins, a space separates ───────────────────────────────────────
test('hyphen: a hyphenated unit name keeps the part after the hyphen', () => {
  assert.equal(_unitCore('3D-A'), '3da');
  assert.equal(_unitCore('3D-B'), '3db');
  // the space-suffix tolerance this rule must not break
  assert.equal(_unitCore('6A Test'), '6a');
  assert.equal(_unitCore('10/F'), '10');
  assert.equal(_unitCore('Unit 22'), '22');
});

test('hyphen: the exact name of a hyphenated unit resolves confidently', () => {
  assert.equal(L('Po Thai 3D-A').match.label, 'Po Thai 3D-A');
  assert.equal(L('Po Thai 3D-B').match.label, 'Po Thai 3D-B');
  // "3D" alone is genuinely ambiguous between them — the customer did not say which
  assert.equal(L('Po Thai 3D').status, 'ambiguous');
});

// A hyphen used as punctuation still separates, so it cannot weld a building name
// to a unit token.
test('hyphen: a spaced hyphen is punctuation, not part of a name', () => {
  const r = L('mong kok - 5a');
  assert.equal(r.status, 'confident');
  assert.equal(r.match.label, 'Mong Kok 5A');
});

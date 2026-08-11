const test = require('node:test');
const assert = require('node:assert');
const { scoreUnits, optionsText, _editDistance, _unitCore } = require('../src/services/unitResolver');

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

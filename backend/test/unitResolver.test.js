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

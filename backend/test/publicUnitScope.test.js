const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_UNIT_NAME_SQL, isPublicUnitName } = require('../src/utils/publicUnitScope');

// ---------------------------------------------------------------------------
// What counts as a PUBLIC unit.
//
// Three surfaces answer prospects — the vacancy feed, /units/search and
// /units/resolve — and until now only the vacancy feed excluded placeholder
// records. The reported symptom was search listing "Test Property 2 Unit 1" as
// an alternative; the worse one, found while checking that report, was the
// resolver returning a CONFIDENT match on "6A Test" for the query "mong kok 6a",
// i.e. naming a test unit back to a customer.
//
// Two kinds of test below, because neither alone is enough:
//
//   BEHAVIOURAL on isPublicUnitName — real assertions on real inputs.
//   TRIPWIRES on the three SQL sites — the predicate lives in a query, so there
//   is nothing to call. These pin the string. They catch DELETION of the clause;
//   they cannot catch a clause neutralised in place, which is the standing
//   limitation of testing SQL this way and is why the behavioural half exists.
//
// Every tripwire slices from WHERE before asserting. A previous test in this
// codebase passed a mutation because the COMMENT above the query contained the
// string the assertion looked for.
// ---------------------------------------------------------------------------

test('isPublicUnitName: excludes the real records that leaked', () => {
  // Each of these is a live production row, not an invented case.
  assert.equal(isPublicUnitName('Unit 1', 'Test Property 2'), false, 'test property, ordinary unit name');
  assert.equal(isPublicUnitName('6A Test', 'Mong Kok'), false, 'real property, test unit — the resolver leak');
  assert.equal(isPublicUnitName('Test Unit 1', 'Test Property'), false, 'test on both sides');
});

test('isPublicUnitName: the positive control — real units stay public', () => {
  // Without this, "the filter excluded it" and "nothing was public anyway" are
  // the same passing assertion.
  assert.equal(isPublicUnitName('5A', 'Mong Kok'), true);
  assert.equal(isPublicUnitName('3/F Unit 1 (Room A and Room B)', 'Fuk Lo Tsun'), true);
  assert.equal(isPublicUnitName('26/F', 'Tai Yuen Apartments'), true);
  assert.equal(isPublicUnitName('4D', 'Poplar'), true);
});

test('isPublicUnitName: case-insensitive on both sides', () => {
  assert.equal(isPublicUnitName('TEST UNIT', 'Mong Kok'), false);
  assert.equal(isPublicUnitName('5A', 'TESTING TOWER'), false);
});

test('isPublicUnitName: null and undefined are not treated as containing "test"', () => {
  // A unit with no name must not be silently withheld — that would hide real
  // stock rather than placeholders.
  assert.equal(isPublicUnitName(null, 'Mong Kok'), true);
  assert.equal(isPublicUnitName('5A', undefined), true);
  assert.equal(isPublicUnitName(null, null), true);
});

test('isPublicUnitName: documents the substring limitation honestly', () => {
  // "Testbourne Road" is a plausible real street name and WOULD be excluded.
  // This is not desirable, it is the accepted cost of a substring rule; asserting
  // it means the trade-off is visible rather than discovered later in production.
  assert.equal(isPublicUnitName('5A', 'Testbourne Road'), false);
  // And the rule catches nothing about a placeholder named something else.
  assert.equal(isPublicUnitName('Demo Unit', 'Mong Kok'), true);
});

// --- Tripwires: the same rule reaches all three query sites -----------------

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('tripwire: the SQL fragment filters BOTH the unit and its property', () => {
  // A predicate that checked only one side would let "Test Property 2 Unit 1"
  // through (unit name is clean) or "6A Test" through (property name is clean).
  // Both halves are load-bearing, and each caught a different real leak.
  assert.match(PUBLIC_UNIT_NAME_SQL, /u\.name.*NOT LIKE '%test%'/);
  assert.match(PUBLIC_UNIT_NAME_SQL, /p\.display_name.*NOT LIKE '%test%'/);
});

test('tripwire: /units/resolve applies the shared scope to its candidate load', () => {
  const src = read('../src/services/unitResolver.js');
  const where = src.slice(src.indexOf('WHERE p.org_id'), src.indexOf('ORDER BY p.display_name'));
  assert.ok(where.length > 0, 'WHERE clause not found — the query was restructured');
  assert.ok(
    /PUBLIC_UNIT_NAME_SQL/.test(where),
    'test units must be excluded from the candidate set, not filtered after scoring'
  );
});

test('tripwire: /units/search applies the shared scope', () => {
  const src = read('../src/services/unitSearch.js');
  const where = src.slice(src.indexOf('let where ='), src.indexOf('const params = [orgId]'));
  assert.ok(where.length > 0, 'base WHERE not found — the query was restructured');
  assert.ok(/PUBLIC_UNIT_NAME_SQL/.test(where), 'search must not offer test units as alternatives');
});

test('tripwire: the vacancy feed still uses the shared definition, not a private copy', () => {
  // computeVacancies had the ONLY copy of this rule before it was shared. If it
  // ever grows a local literal again the three surfaces can drift apart, which is
  // the exact failure this module exists to prevent.
  const src = read('../src/routes/advertising.js');
  assert.ok(/const NOT_TEST = PUBLIC_UNIT_NAME_SQL;/.test(src),
    'advertising.js must alias the shared predicate rather than redefine it');
});

/**
 * The door code reaches the two places staff read it.
 *
 * It is read during a checkout inspection, so it has to be on the lease details
 * page AND on the check-in/check-out schedule that the inspection is planned
 * from. Both are React pages; exercising them needs a browser, so this reads the
 * source — the same approach checkinWiring.test.js takes, and for the same
 * reason: the realistic regression is a later edit dropping a column or an
 * import, not someone rewriting the feature.
 *
 * The load-bearing fact is WHICH field. unit.key_code is the obvious-looking
 * one and is filled in on 2 of 118 units (one of them the word "Test"), while
 * leasing.unit_information carries the code on 102 of the 137 current and
 * upcoming leases. A well-meaning edit to the "proper" column would empty the
 * feature without failing anything else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const LEASING_ROUTE = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'leasing.js'), 'utf8');
const SCHEDULE_PAGE = read('frontend/src/app/leasing/check-in-out/page.js');
const DETAIL_PAGE = read('frontend/src/app/leasing/[id]/detail/page.js');
const FORMAT = read('frontend/src/lib/format.js');
const UNIT_PAGE = read('frontend/src/app/property/[id]/unit/[unitid]/page.js');

// Bounded to the check-in-out handler: a match anywhere else in a 1,700-line
// route file would prove nothing about THIS query.
function routeBlock(start, end) {
  const from = LEASING_ROUTE.indexOf(start);
  assert.ok(from !== -1, `route not found: ${start}`);
  const to = LEASING_ROUTE.indexOf(end, from);
  assert.ok(to !== -1, `end marker not found after ${start}: ${end}`);
  return LEASING_ROUTE.slice(from, to);
}

test('door code: the schedule query selects it from the LEASE, not the unit', () => {
  const block = routeBlock("router.get('/check-in-out'", "router.get('/:id'");
  assert.match(block, /l\.unit_information AS door_code/,
    'the check-in-out query must return the lease\'s unit_information as door_code');
  assert.doesNotMatch(block, /u\.key_code/,
    'unit.key_code is set on 2 of 118 units — it is not the door code');
});

test('door code: the lease detail endpoint already returns the field', () => {
  const block = routeBlock("router.get('/:id'", 'router.put');
  assert.match(block, /SELECT l\.\*/,
    'the detail page reads unit_information straight off SELECT l.* — a narrowed column list must add it back');
});

test('door code: both surfaces render it, through the one shared helper', () => {
  for (const [name, src] of [['schedule card', SCHEDULE_PAGE], ['lease details', DETAIL_PAGE]]) {
    assert.match(src, /import \{ formatDoorCode \}/, `${name} must use the shared helper`);
    assert.match(src, /formatDoorCode\(/, `${name} must call it`);
  }
  assert.match(SCHEDULE_PAGE, /row\.door_code/, 'the card reads the column the query aliases');
  assert.match(DETAIL_PAGE, /label="Door Code"/, 'the lease details row must be labelled');
});

// Under the Unit on both, because on an inspection they are one question.
test('door code: it sits below the unit on both surfaces', () => {
  const detailUnit = DETAIL_PAGE.indexOf('label="Unit"');
  const detailCode = DETAIL_PAGE.indexOf('label="Door Code"');
  assert.ok(detailUnit !== -1 && detailCode > detailUnit, 'Door Code must follow Unit in lease details');

  const cardUnit = SCHEDULE_PAGE.indexOf('row.unit_name');
  const cardCode = SCHEDULE_PAGE.indexOf('doorCode.short');
  assert.ok(cardUnit !== -1 && cardCode > cardUnit, 'the code must render below the unit on the card');
});

// An empty row would read as "no code needed"; 35 of 137 current leases simply
// have nothing recorded, which is a different thing.
test('door code: the card omits the line entirely when nothing is recorded', () => {
  assert.match(SCHEDULE_PAGE, /\{doorCode && \(/, 'the card line must be guarded, not rendered empty');
});

// The helper is the whole behaviour, so pin it here rather than trusting the
// prose: Salto units have no code to read out at all.
test('door code: long Salto instructions collapse, short entries do not', () => {
  const body = FORMAT.slice(FORMAT.indexOf('export function formatDoorCode'));
  assert.match(body, /SALTO_PATTERN\.test\(full\) && full\.length > 60/,
    'collapsing must require BOTH the word and the length — "Salto, gate code 8362" is a usable answer');
  assert.match(body, /collapsed \? 'Salto' : full/);
  assert.match(body, /split\('\\n'\)/, 'short form is the first line, for one-line slots');
});

// ─── the unit page reads the CURRENT lease, not the unit ────────────────────
//
// This card used to print unit.key_code and had gone stale in the only place it
// mattered: Cleverly 8B showed 664851# while the tenant living there had 439012#.
// A door code changes with the tenant, so it belongs to the lease. Reading the
// lease that is running today means the card re-dates itself on every turnover
// with nobody remembering to edit the unit.
test('door code: the unit page shows the current lease\'s code, not unit.key_code', () => {
  assert.match(UNIT_PAGE, /title="DOOR CODE"/, 'the card must be titled Door Code');
  assert.doesNotMatch(UNIT_PAGE, /title="KEY CODES"/, 'the stale unit-level card must be gone');
  assert.doesNotMatch(UNIT_PAGE, /unit\?\.key_code/, 'nothing on this page may read unit.key_code again');
  assert.match(UNIT_PAGE, /formatDoorCode\(currentLease\?\.unit_information\)/,
    'it must read the lease running today, through the shared helper');
});

// "No active lease" and "no code recorded" both mean there is nothing to give
// out, so both show the same dash the sibling cards use.
test('door code: the unit card is blank between tenancies', () => {
  const card = UNIT_PAGE.slice(UNIT_PAGE.indexOf('title="DOOR CODE"'));
  assert.match(card.slice(0, 700), /if \(!code\) return <Text type="secondary">--<\/Text>/);
});

// The endpoint behind it must keep selecting by TODAY, or the card silently
// starts showing a past tenant's code.
test('door code: the unit lease endpoint is bounded to today', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'property.js'), 'utf8');
  const from = src.indexOf("router.get('/unit/:unit_id/current-lease'");
  assert.ok(from !== -1, 'current-lease route not found');
  const block = src.slice(from, from + 1400);
  assert.match(block, /l\.start_date <= \$\{orgTodaySql\(\)\}/, 'the current lease must have started');
  assert.match(block, /l\.end_date >= \$\{orgTodaySql\(\)\} OR l\.end_date IS NULL/, 'and not have ended');
  assert.match(block, /SELECT l\.\*/, 'unit_information reaches the page via SELECT l.*');
});

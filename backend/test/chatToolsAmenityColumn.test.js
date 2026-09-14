/**
 * get_unit_details had never once returned a unit.
 *
 * It selected `a.name` from the amenity table. That table's label column is
 * `display_name` — there is no `name` — so MySQL threw "Unknown column 'a.name'
 * in 'field list'" on every call. The tool loop in routes/chat.js catches a thrown
 * tool and hands the model `{ error: <message> }`, so nothing crashed and nothing
 * logged as broken: TaneChat simply got a database error every time a prospect
 * narrowed down to one unit and asked about it, and improvised from whatever the
 * earlier search had returned.
 *
 * The tool's own description tells the model to call it "after the user has
 * narrowed down to a specific unit", so this was the main path for a named unit.
 * Everything in the payload went with it: amenities, beds, baths, the price range,
 * the listing URL, the property address.
 *
 * Verified against production after the fix: Fuk Lo Tsun 2I returns 21 amenities.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// The amenity table, as it actually exists. Anything else is a thrown query.
const AMENITY_COLUMNS = new Set([
  'id', 'org_id', 'display_name', 'category', 'type', 'enabled', 'order_id',
]);

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('the unit-detail amenity query reads the column the table actually has', () => {
  const src = read('../src/services/chatTools.js');
  const i = src.indexOf('FROM unit_amenity ua');
  assert.ok(i > 0, 'the amenity lookup should still be there');
  const query = src.slice(i - 200, i + 200);
  assert.match(query, /a\.display_name AS name/);
  assert.doesNotMatch(query, /SELECT[^`]*\ba\.name\b/,
    'a.name does not exist on the amenity table');
});

test('the tool still hands the model a plain `name` on each amenity', () => {
  // The SQL alias is load-bearing: the handler maps amens.map(a => a.name), and
  // the model is shown a list of amenity names. Renaming the column in the SELECT
  // without the alias would return rows whose name is undefined — an empty
  // amenity list, which reads to a prospect as "this flat has nothing".
  const src = read('../src/services/chatTools.js');
  assert.match(src, /amenities: amens\.map\(a => a\.name\)/);
});

test('no query anywhere selects a column the amenity table does not have', () => {
  // The class of bug, not just the one instance. Any `<alias>.<column>` written
  // against a query that joins `amenity` must name a real column.
  const offenders = [];
  for (const file of jsFilesUnder(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    // Each backtick template that touches the amenity table.
    for (const m of src.matchAll(/`([^`]*\bamenity\b[^`]*)`/g)) {
      const query = m[1];
      // The alias given to `amenity` in this query, e.g. "JOIN amenity a ON".
      const alias = query.match(/\bamenity\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/i);
      if (!alias) continue;
      const a = alias[1];
      if (a === 'ON' || a === 'on') continue;
      for (const ref of query.matchAll(new RegExp(`\\b${a}\\.([a-z_][a-z0-9_]*)\\b`, 'gi'))) {
        const col = ref[1].toLowerCase();
        if (col === '*' || AMENITY_COLUMNS.has(col)) continue;
        offenders.push(`${path.relative(SRC, file)}: ${a}.${ref[1]}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `queries naming a column the amenity table does not have:\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// The model only uses what the tool contract tells it about.
//
// search_available_units returns each unit's amenity list (unitSearch.js:477),
// but its description never said so — it documented the fit metadata,
// asking_rent and listing_url and stopped there. So whether the bot mentioned
// "Shared Bathroom" came down to the model noticing an undocumented field.
//
// That is not a cosmetic gap. Fuk Lo Tsun's fourteen studios share a floor
// bathroom and a laundry room, and the `baths` filter counts a shared bathroom
// as one, so a prospect asking for a unit with a bathroom matches all fourteen.
// The amenity list is the only thing that says "shared", and it has to be read.
// ---------------------------------------------------------------------------

test('the search tool tells the model amenities are in the response', () => {
  const { ALL_BY_NAME } = require('../src/services/chatTools');
  const fn = ALL_BY_NAME.search_available_units.definition.function;

  assert.match(fn.description, /`amenities`/,
    'the description must name the amenities field');
  assert.match(fn.description, /Shared Bathroom/,
    'it must show the model what a communal facility looks like');
  assert.match(fn.description, /never present one of those as\s+private or in-unit/,
    'and say plainly not to describe a shared facility as private');
});

test('the baths filter warns that the count includes shared bathrooms', () => {
  // Fourteen FLT studios report baths: 1 for a bathroom they share, which is the
  // honest count. Without this note the model reads 1 as "has its own".
  const { ALL_BY_NAME } = require('../src/services/chatTools');
  const baths = ALL_BY_NAME.search_available_units.definition.function
    .parameters.properties.baths.description;

  assert.match(baths, /communal ones included/i);
  assert.match(baths, /Shared Bathroom/);
});

test('the amenity names the tool advertises are the ones in the catalogue', () => {
  // The description quotes three amenity labels at the model. If someone renames
  // one in the catalogue, the quoted example goes stale and the instruction stops
  // matching the data. These are the labels the seeded catalogue uses.
  const { ALL_BY_NAME } = require('../src/services/chatTools');
  const fn = ALL_BY_NAME.search_available_units.definition.function;
  for (const label of ['Shared Bathroom', 'Shared Washing Machine', 'Shared Dryer']) {
    assert.ok(fn.description.includes(label), `description should quote "${label}"`);
  }
});

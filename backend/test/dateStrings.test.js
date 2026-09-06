/**
 * DATE and DATETIME must arrive as strings; TIMESTAMP must not.
 *
 * The schema uses all three to mean different things, and only TIMESTAMP is an absolute
 * instant. Letting mysql2 build JavaScript Dates from the other two reads them against
 * the process timezone (UTC on the droplet), so a DATETIME meaning "6am in Hong Kong"
 * reached the browser as 06:00Z and drew as 2pm.
 *
 * That was not merely cosmetic: the staff edit form loaded the shifted value and saved it
 * back, moving every window eight hours later per save, and 141 of 1,702 service requests
 * ended up with an end BEFORE their start.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const POOLS = ['../src/config/database.js', '../src/config/poolRegistry.js'];

for (const rel of POOLS) {
  test(`${path.basename(rel)} returns DATE and DATETIME as strings`, () => {
    const code = stripComments(read(rel));
    assert.match(code, /dateStrings:\s*\['DATE',\s*'DATETIME'\]/,
      'the pool no longer pins dateStrings, so wall-clock columns will shift again');
  });

  test(`${path.basename(rel)} does NOT stringify TIMESTAMP`, () => {
    // A blanket `dateStrings: true` would sweep TIMESTAMP in too. Those are real
    // instants; as a bare string they lose their zone and created_at would render eight
    // hours early for a Hong Kong reader.
    const code = stripComments(read(rel));
    assert.ok(!/dateStrings:\s*true/.test(code), 'dateStrings: true also stringifies TIMESTAMP');
    assert.ok(!/'TIMESTAMP'/.test(code), 'TIMESTAMP is being returned as a string');
  });
}

test('process.env.TZ is never set', () => {
  // The one-line-looking alternative. utils/orgTime.js explains why it is a trap:
  // mysql2 parses stored DATETIMEs against the process timezone, so changing it
  // reinterprets every timestamp already in the database.
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      if (/process\.env\.TZ\s*=/.test(stripComments(fs.readFileSync(full, 'utf8')))) offenders.push(name);
    }
  };
  walk(path.join(__dirname, '../src'));
  assert.deepEqual(offenders, [], 'something assigns process.env.TZ');
});

// ── the forms that write these columns ──────────────────────────────────────

const FORMS = [
  ['../../frontend/src/app/services/[id]/edit/page.js', 'edit'],
  ['../../frontend/src/app/services/create/page.js', 'create'],
];

for (const [rel, label] of FORMS) {
  test(`the service ${label} form writes each end from its own date`, () => {
    // The old shape built BOTH ends from the start date, so a window crossing midnight
    // came back ending before it began, and simply opening and saving rewrote it.
    const code = stripComments(read(rel));
    assert.ok(!/preferred_date_first_end\s*=\s*`\$\{dateStr\}/.test(code),
      'the end is still composed from the start date');
    assert.match(code, /pref1_range/);
    assert.match(code, /pref2_range/);
    assert.match(code, /range\[1\]\.format\('YYYY-MM-DD HH:mm:ss'\)/);
  });

  test(`the service ${label} form offers one range control per option`, () => {
    const code = stripComments(read(rel));
    assert.match(code, /name="pref1_range"[\s\S]{0,200}?DatePicker\.RangePicker/);
    assert.match(code, /name="pref2_range"[\s\S]{0,200}?DatePicker\.RangePicker/);
  });
}

test('the tenant portal and the staff forms agree on the stored format', () => {
  // Both write a Hong Kong wall clock with no zone marker, which is what the column
  // holds. A value with a Z on it would be reinterpreted on read.
  const portal = stripComments(read('../../frontend/src/app/tenant-portal/repairs/page.js'));
  assert.match(portal, /format\('YYYY-MM-DD HH:mm'\)/);
  for (const [rel] of FORMS) {
    assert.match(stripComments(read(rel)), /format\('YYYY-MM-DD HH:mm:ss'\)/);
  }
});

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
  test(`${path.basename(rel)} returns DATE as a string and DATETIME as a Date`, () => {
    // DATETIME deliberately excluded. It means two different things here: appointment
    // times hold a Hong Kong wall clock, but 24 audit columns hold UTC because NOW()
    // writes them and NOW() on this server is UTC. Stringifying both fixes the first and
    // renders the second eight hours early. The wall-clock columns are pulled out with
    // DATE_FORMAT in the queries that know which kind they are.
    const code = stripComments(read(rel));
    assert.match(code, /dateStrings:\s*\['DATE'\]/,
      'the pool no longer pins dateStrings, so DATE columns can shift a day again');
    assert.ok(!/'DATETIME'/.test(code), 'DATETIME is being stringified again');
  });

  test(`${path.basename(rel)} does NOT stringify TIMESTAMP either`, () => {
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

// ── the wall-clock columns are formatted where their meaning is known ────────

test('the service queries pull wall-clock columns as formatted strings', () => {
  // The pool cannot tell an appointment time from an audit stamp; the query can. Without
  // DATE_FORMAT these come back as Dates, are read as UTC and drawn eight hours late.
  const WALL_CLOCK = [
    'preferred_date_first_start', 'preferred_date_first_end',
    'preferred_date_second_start', 'preferred_date_second_end',
    'service_date_start', 'service_date_end',
  ];
  const staff = read('../src/routes/service.js');
  const detail = staff.slice(staff.indexOf('const [services] = await req.pool.execute'), staff.indexOf('// Fetch linked files'));
  for (const col of WALL_CLOCK) {
    assert.ok(detail.includes(`DATE_FORMAT(s.${col},`), `staff detail does not format ${col}`);
  }

  const portal = read('../src/routes/tenantPortal.js');
  const list = portal.slice(portal.indexOf("router.get('/service'"), portal.indexOf('ORDER BY s.created_at DESC'));
  for (const col of WALL_CLOCK) {
    assert.ok(list.includes(`DATE_FORMAT(s.${col},`), `the portal list does not format ${col}`);
  }
});

test('created_at is NOT formatted as a wall clock', () => {
  // It is DATETIME but holds UTC, written by NOW(). Formatting it would render it eight
  // hours early — the exact mistake, in the opposite direction.
  const portal = read('../src/routes/tenantPortal.js');
  const list = portal.slice(portal.indexOf("router.get('/service'"), portal.indexOf('ORDER BY s.created_at DESC'));
  assert.ok(!/DATE_FORMAT\(s\.created_at/.test(list), 'created_at is being treated as a wall clock');
});

/**
 * ask_data SQL guard — the app-side half of the read-only guarantee.
 * (The other half is the SELECT-only MySQL user the query actually runs as.)
 */
const test = require('node:test');
const assert = require('node:assert');
const { validateSelect, MAX_ROWS } = require('../src/services/askDataService');

test('accepts a plain SELECT and injects a LIMIT', () => {
  const r = validateSelect('SELECT id, display_name FROM property');
  assert.equal(r.ok, true);
  assert.match(r.sql, new RegExp(`LIMIT ${MAX_ROWS}\\s*$`, 'i'));
});

test('keeps an existing LIMIT instead of double-adding', () => {
  const r = validateSelect('SELECT id FROM property LIMIT 10');
  assert.equal(r.ok, true);
  assert.equal((r.sql.match(/LIMIT/gi) || []).length, 1);
});

test('allows a leading CTE (WITH ... SELECT)', () => {
  const r = validateSelect('WITH x AS (SELECT id FROM unit) SELECT * FROM x');
  assert.equal(r.ok, true);
});

test('strips a single trailing semicolon but rejects chained statements', () => {
  assert.equal(validateSelect('SELECT 1 FROM property;').ok, true);
  assert.equal(validateSelect('SELECT 1 FROM property; DROP TABLE property').ok, false);
});

test('rejects writes and DDL', () => {
  const bad = [
    'UPDATE property SET display_name = "x"',
    'DELETE FROM tenant',
    'INSERT INTO tenant (id) VALUES (1)',
    'DROP TABLE property',
    'ALTER TABLE property ADD COLUMN x INT',
    'TRUNCATE TABLE invoice',
    'CREATE TABLE x (id INT)',
    'GRANT ALL ON *.* TO "a"@"b"',
    'REPLACE INTO tenant VALUES (1)',
    'CALL some_proc()',
  ];
  for (const q of bad) {
    assert.equal(validateSelect(q).ok, false, `must reject: ${q}`);
  }
});

test('rejects a write smuggled after a valid SELECT prefix', () => {
  assert.equal(validateSelect('SELECT 1 FROM property UNION SELECT 1; UPDATE tenant SET x=1').ok, false);
  // keyword appearing mid-query is still rejected (no write verbs anywhere)
  assert.equal(validateSelect('SELECT * FROM (DELETE FROM tenant) t').ok, false);
});

test('rejects file/system access and non-string input', () => {
  assert.equal(validateSelect('SELECT * FROM property INTO OUTFILE "/tmp/x"').ok, false);
  assert.equal(validateSelect('SELECT * FROM mysql.user').ok, false);
  assert.equal(validateSelect('').ok, false);
  assert.equal(validateSelect(null).ok, false);
  assert.equal(validateSelect(42).ok, false);
});

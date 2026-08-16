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

// ---------------------------------------------------------------------------
// Hong Kong dates. The model writes this SQL itself, so it cannot bind a
// parameter — the prompt tells it today's date, and this is the safety net for
// when it reaches for CURDATE() anyway. Rewriting beats rejecting: a rejected
// query loses the answer, a rewritten one is simply correct.
// ---------------------------------------------------------------------------

const { orgToday } = require('../src/utils/orgTime');

test('rewrites CURDATE() to the Hong Kong date', () => {
  const r = validateSelect('SELECT id FROM invoice WHERE due_on < CURDATE()');
  assert.equal(r.ok, true);
  assert.ok(!/CURDATE/i.test(r.sql), `CURDATE() survived: ${r.sql}`);
  assert.ok(r.sql.includes(`'${orgToday()}'`), `expected today's HK date in: ${r.sql}`);
});

test('rewrites CURRENT_DATE, with or without parentheses', () => {
  for (const form of ['CURRENT_DATE', 'CURRENT_DATE()', 'current_date']) {
    const r = validateSelect(`SELECT id FROM leasing WHERE end_date >= ${form}`);
    assert.equal(r.ok, true, `${form} was rejected`);
    assert.ok(!/CURRENT_DATE/i.test(r.sql), `${form} survived: ${r.sql}`);
    assert.ok(r.sql.includes(`'${orgToday()}'`), `${form} did not become a date: ${r.sql}`);
  }
});

test('rewrites every occurrence, not just the first', () => {
  const r = validateSelect(
    'SELECT id FROM leasing WHERE start_date <= CURDATE() AND end_date >= CURDATE()'
  );
  assert.equal(r.ok, true);
  assert.equal((r.sql.match(/CURDATE/gi) || []).length, 0);
  assert.equal((r.sql.match(new RegExp(`'${orgToday()}'`, 'g')) || []).length, 2);
});

test('leaves NOW() alone — DATETIME columns are stored in UTC', () => {
  // Business DATES are Hong Kong calendar dates, but DATETIME columns hold UTC
  // instants (mysql2 writes them in the process timezone, which is UTC on the
  // server). Rewriting NOW() to a Hong Kong wall clock would be eight hours out.
  const r = validateSelect('SELECT id FROM chat_message WHERE created_at > NOW() - INTERVAL 1 DAY');
  assert.equal(r.ok, true);
  assert.match(r.sql, /NOW\(\)/i);
});

test('does not mangle a column whose name merely contains the word', () => {
  const r = validateSelect('SELECT curdate_snapshot FROM report_cache');
  assert.equal(r.ok, true);
  assert.match(r.sql, /curdate_snapshot/);
});

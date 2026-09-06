/**
 * Table aliases must not be MySQL 8 reserved words.
 *
 * `FROM object_file of` is a syntax error on MySQL 8, and the failure is invisible until
 * the query actually runs. The one that shipped sat behind `if (ids.length)`, so it never
 * executed while a tenant had no repairs, passed every review and every source-level
 * test, and broke on the first real submission.
 *
 * Source assertions cannot catch this class on their own, which is the point of scanning
 * for the alias rather than trusting the shape of the query.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Reserved in MySQL 8 and short enough to be tempting as an alias. Not the full list:
// this is the set a developer would plausibly reach for when aliasing a table.
const RESERVED = new Set([
  'of', 'rank', 'system', 'groups', 'window', 'lead', 'lag', 'first', 'last',
  'over', 'recursive', 'lateral', 'empty', 'grouping', 'array', 'member',
  'cume_dist', 'dense_rank', 'ntile', 'percent_rank', 'row_number', 'except',
  'rows', 'range', 'current', 'function', 'optimizer_costs', 'get',
]);

// FROM/JOIN <table> [AS] <alias>, where the alias is a bare identifier.
//
// Case-SENSITIVE on the keyword. Every query in this codebase writes FROM and JOIN in
// caps, while English prose writes "from the last invoice", and matching either way
// turned the first run of this test into nine false positives out of nine.
const ALIAS = /\b(FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/g;

// Comments are stripped before scanning for the same reason.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Words that follow a table name but are clause keywords, not aliases.
const CLAUSE = new Set(['on', 'where', 'set', 'values', 'join', 'inner', 'left', 'right',
  'outer', 'cross', 'straight_join', 'using', 'group', 'order', 'limit', 'having',
  'union', 'as', 'for', 'select', 'and', 'or', 'natural', 'partition', 'force', 'use', 'ignore']);

function scan(dir) {
  const problems = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { problems.push(...scan(full)); continue; }
    if (!name.endsWith('.js')) continue;
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    for (const m of src.matchAll(ALIAS)) {
      const alias = m[3].toLowerCase();
      if (CLAUSE.has(alias) || !RESERVED.has(alias)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${path.relative(path.join(__dirname, '..'), full)}:${line}  ${m[1]} ${m[2]} ${m[3]}`);
    }
  }
  return problems;
}

test('no SQL in the backend aliases a table to a reserved word', () => {
  const problems = scan(path.join(__dirname, '../src'));
  assert.deepEqual(problems, [],
    'reserved-word table aliases found (MySQL 8 rejects these at parse time):\n  ' + problems.join('\n  '));
});

test('the scanner actually catches the alias that shipped', () => {
  // Guards the guard. A regex that matches nothing would pass the test above forever.
  const sample = "FROM object_file of JOIN file f ON f.id = of.file_id";
  const hits = [...sample.matchAll(ALIAS)].filter(m => RESERVED.has(m[3].toLowerCase()));
  assert.equal(hits.length, 1);
  assert.equal(hits[0][2], 'object_file');
  assert.equal(hits[0][3], 'of');
});

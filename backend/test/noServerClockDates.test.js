/**
 * Repo-wide fence for the Hong Kong clock.
 *
 * ~130 sites were migrated off the server clock at once. The realistic way that
 * regresses is not someone undoing it deliberately — it is a new query written
 * later, copied from an older one, that reaches for CURDATE() again. This file
 * makes that a test failure instead of a bug nobody notices for eight hours a day.
 *
 * Two rules:
 *   1. No CURDATE()/CURRENT_DATE in application SQL. MySQL resolves it against the
 *      server's clock (UTC), which is a day behind Hong Kong from 00:00 to 08:00.
 *   2. No orgToday()/orgTodaySql() at module scope. Those are evaluated once at
 *      require() time, so a constant built from one reports the day the process
 *      booted until the next restart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/');

// Prose is allowed to name the thing it forbids. Exactly one place does: the
// ask_data system prompt, which tells the model never to use CURDATE(). Anything
// else naming it outside a comment is a real query and must fail.
const PROSE_ALLOWED = new Set([
  'src/services/chatTools.js',
]);

const isCommentLine = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

test('no application SQL uses the MySQL server clock for a business date', () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bCURDATE\s*\(\s*\)|\bCURRENT_DATE\b/.test(line)) return;
      if (isCommentLine(line)) return;                 // documentation, fine
      if (PROSE_ALLOWED.has(rel(file))) return;        // the prompt that forbids it
      offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'Use `${orgTodaySql()}` (from utils/orgTime) instead — CURDATE() resolves to the '
    + 'UTC date and is a day behind Hong Kong every night between 00:00 and 08:00.');
});

// The JS "today from the UTC clock" rule now lives in test/utcTodayDetector.test.js,
// which parses the code instead of grepping it. That check catches the aliased form
// this line-based one walked straight past. Keeping both would leave two rules
// disagreeing about the same thing, so only the parser-based one remains.

test('no module-level constant captures today at require() time', () => {
  // A top-level `const X = ...orgToday()...` is evaluated once when the module
  // loads, so the value is the day the process booted. Indented declarations are
  // inside a function and re-evaluate per call, which is what we want.
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    // `continue`, not `return` — a return here would abandon the whole scan the
    // moment it reached this file, silently skipping everything after it.
    if (rel(file) === 'src/utils/orgTime.js') continue;  // the helper itself
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=.*\borgToday(Sql)?\s*\(/.test(line)) {
        offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'Build the value inside the function that uses it — a module-level constant '
    + 'freezes the date at boot and holds it until the next restart.');
});

test('the fence would actually catch a regression', () => {
  // Guards the guard: if the detection regexes stopped matching, the three tests
  // above would pass on a codebase riddled with the bug and nobody would know.
  const sqlLine = '  const sql = `SELECT 1 WHERE d < CURDATE()`;';
  const frozen = 'const TODAY_SQL = `WHERE d = ${orgTodaySql()}`;';

  assert.ok(/\bCURDATE\s*\(\s*\)|\bCURRENT_DATE\b/.test(sqlLine) && !isCommentLine(sqlLine));
  assert.ok(/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=.*\borgToday(Sql)?\s*\(/.test(frozen));

  // ...and that a comment mentioning them is still allowed through.
  assert.ok(isCommentLine('  // never use CURDATE() here'));
  assert.ok(isCommentLine('   * CURDATE() resolves against the server clock'));
});

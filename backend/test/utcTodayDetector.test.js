/**
 * Tests for the UTC-today detector.
 *
 * Written BEFORE reading the detector's implementation, and deliberately harder
 * than the cases in its specification — a detector graded against the examples it
 * was built from proves nothing.
 *
 * Two failure modes matter, and they are not symmetric:
 *
 *   MISS      — the bug ships. Bad, but no worse than having no detector.
 *   FALSE HIT — a legitimate line is flagged. Worse: people learn to ignore the
 *               test, and then it stops catching the real thing too.
 *
 * So the "must not flag" half is the more important half.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { findUtcTodayDerivations } = require('./lib/utcTodayDetector');

const find = (src) => findUtcTodayDerivations(src, 'sample.js');
const hits = (src) => find(src).length;

// ---------------------------------------------------------------------------
// MUST CATCH
// ---------------------------------------------------------------------------

const MUST_CATCH = {
  'direct, split': `function f() { const t = new Date().toISOString().split('T')[0]; return t; }`,
  'direct, slice': `function f() { return new Date().toISOString().slice(0, 10); }`,
  'direct, substring': `function f() { return new Date().toISOString().substring(0, 10); }`,
  'direct, substr': `function f() { return new Date().toISOString().substr(0, 10); }`,

  // The one that actually shipped, and that the old line-based check walked past.
  'aliased over two lines': `function f() {
     const now = new Date();
     return now.toISOString().split('T')[0];
   }`,

  'aliased via let + assignment': `function f() {
     let d;
     d = new Date();
     return d.toISOString().substring(0, 10);
   }`,

  'aliased twice': `function f() {
     const a = new Date();
     const b = a;
     return b.toISOString().slice(0, 10);
   }`,

  'Date.now seeded': `function f() { return new Date(Date.now()).toISOString().slice(0, 10); }`,
  'toJSON instead of toISOString': `function f() { return new Date().toJSON().split('T')[0]; }`,
  'split then .at(0)': `function f() { return new Date().toISOString().split('T').at(0); }`,
  'inside a template literal': "function f() { return `${new Date().toISOString().slice(0, 10)}`; }",

  'hand-built from UTC getters': `function f() {
     const n = new Date();
     return n.getUTCFullYear() + '-' + String(n.getUTCMonth() + 1) + '-' + String(n.getUTCDate());
   }`,

  'at module top level': `const today = new Date().toISOString().split('T')[0];`,

  'inside an arrow function': `const f = () => new Date().toISOString().slice(0, 10);`,

  'inside a method': `const o = { f() { return new Date().toISOString().split('T')[0]; } };`,

  'ternary picks a now-date': `function f(x) {
     const d = x ? new Date() : new Date();
     return d.toISOString().slice(0, 10);
   }`,

  'default via ||': `function f(given) {
     const d = given || new Date();
     return d.toISOString().slice(0, 10);
   }`,
};

for (const [name, src] of Object.entries(MUST_CATCH)) {
  test(`catches: ${name}`, () => {
    assert.ok(hits(src) >= 1, `NOT CAUGHT — this is the bug:\n${src}`);
  });
}

// ---------------------------------------------------------------------------
// MUST NOT FLAG — the more important half
// ---------------------------------------------------------------------------

const MUST_NOT_FLAG = {
  // These convert a SPECIFIC STORED date. They are correct and extremely common;
  // flagging them would make the whole check noise.
  'stored cursor date': `function f(cursor) { return cursor.toISOString().split('T')[0]; }`,
  'stored column, dotted': `function f(lease) { return lease.end_date.toISOString().slice(0, 10); }`,
  'a parameter': `function f(periodStart) { return periodStart.toISOString().slice(0, 10); }`,
  'row field': `function f(row) { return row.reading_date.toISOString().split('T')[0]; }`,
  'new Date(storedValue)': `function f(v) { return new Date(v).toISOString().slice(0, 10); }`,
  'new Date(row.due_on)': `function f(row) { return new Date(row.due_on).toISOString().split('T')[0]; }`,

  // Full ISO of "now" is legitimate — APIs, iCal DTSTAMP, JSON payloads, logs.
  // Only the TRUNCATION to a calendar date is the bug.
  'full ISO string of now': `function f() { return new Date().toISOString(); }`,
  'ISO of now in an object': `function f() { return { timestamp: new Date().toISOString() }; }`,

  // A timestamp, not a calendar date — a different concern entirely.
  'now truncated to minutes': `function f() { return new Date().toISOString().slice(0, 16); }`,
  'now truncated to seconds': `function f() { return new Date().toISOString().slice(0, 19); }`,

  // Plain instants.
  'Date.now()': `function f() { return Date.now(); }`,
  'getTime': `function f() { return new Date().getTime(); }`,
  'date arithmetic': `function f() { return new Date(Date.now() - 86400000); }`,

  // The correct helper must never be flagged.
  'orgToday': `function f() { return orgToday(); }`,
  'orgTodayDate then ISO': `function f() { return orgTodayDate().toISOString().slice(0, 10); }`,

  // Local getters are a DIFFERENT bug class (server-zone dependent), deliberately
  // out of scope — dbDate() uses exactly this shape on purpose.
  'local getters on a stored date': `function f(v) {
     return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0');
   }`,

  // Strings that merely look like the pattern.
  'the pattern inside a string literal': `function f() { return "new Date().toISOString().split('T')[0]"; }`,
  'the pattern inside a comment': `function f() {
     // never write new Date().toISOString().split('T')[0]
     return orgToday();
   }`,
};

for (const [name, src] of Object.entries(MUST_NOT_FLAG)) {
  test(`does NOT flag: ${name}`, () => {
    const found = find(src);
    assert.equal(found.length, 0,
      `FALSE POSITIVE — this line is legitimate:\n${src}\nflagged: ${JSON.stringify(found)}`);
  });
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('a syntax error is reported, never silently ignored', () => {
  // If an unparseable file returned "no findings", one stray typo would quietly
  // switch the check off for that file — the failure mode that makes a guard
  // worse than useless.
  const found = find('function f( { return');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'parse-error');
});

test('findings carry enough detail to act on', () => {
  const [f] = find(`function f() {\n  const t = new Date().toISOString().split('T')[0];\n}`);
  assert.ok(f, 'expected a finding');
  assert.equal(f.line, 2, 'line number must point at the offending line');
  assert.equal(typeof f.snippet, 'string');
  assert.ok(f.snippet.length > 0);
  assert.ok(typeof f.why === 'string' && f.why.length > 0, 'a finding must explain itself');
});

test('scopes do not leak into one another', () => {
  // `d` is a now-date in one function and a parameter in the other. If the
  // detector kept one shared table of tainted names it would flag the second.
  const src = `
    function a() { const d = new Date(); return d.toISOString().slice(0, 10); }
    function b(d) { return d.toISOString().slice(0, 10); }
  `;
  const found = find(src);
  assert.equal(found.length, 1, `expected exactly one finding, got ${JSON.stringify(found)}`);
  assert.ok(found[0].line <= 2, 'the finding must be in function a, not b');
});

test('a shadowed name is not treated as tainted', () => {
  const src = `
    function a() {
      const d = new Date();
      function inner(d) { return d.toISOString().slice(0, 10); }
      return inner(someStoredDate);
    }
  `;
  // `d` inside `inner` is a parameter shadowing the outer one, so it is unknown,
  // not now. Flagging it would be a false positive.
  assert.equal(find(src).length, 0, 'a shadowing parameter must not inherit taint');
});

test('the whole source tree is clean', () => {
  // The real point of all this. Runs the detector over src/ and fails on any hit.
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..', 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
  const offenders = [];
  for (const file of walk(SRC)) {
    for (const f of findUtcTodayDerivations(fs.readFileSync(file, 'utf8'), file)) {
      offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${f.line}  ${f.snippet}`);
    }
  }
  assert.deepEqual(offenders, [],
    'Use orgToday() — toISOString() is always UTC, which is a day behind Hong Kong '
    + 'between midnight and 08:00.');
});

// ---------------------------------------------------------------------------
// Closures. Capturing the date and using it inside a callback is ordinary code,
// so scope isolation alone would miss a whole realistic class of the bug. Nested
// scopes inherit, minus anything the inner function re-binds.
// ---------------------------------------------------------------------------

test('catches a now-date captured in a callback', () => {
  assert.ok(hits(`function g(items) {
    const now = new Date();
    return items.map(x => now.toISOString().split('T')[0]);
  }`) >= 1);
});

test('catches a now-date captured in a promise callback', () => {
  assert.ok(hits(`function g(p) {
    const now = new Date();
    return p.then(() => now.toISOString().slice(0, 10));
  }`) >= 1);
});

test('a parameter of the same name does not inherit taint', () => {
  assert.equal(hits(`function a() {
    const d = new Date();
    return [1].map(function (d) { return d.toISOString().slice(0, 10); });
  }`), 0);
});

test('a destructured parameter of the same name does not inherit taint', () => {
  assert.equal(hits(`function a(xs) {
    const d = new Date();
    return xs.map(({ d }) => d.toISOString().slice(0, 10));
  }`), 0);
});

test('re-declaring the name from a stored value clears the taint', () => {
  assert.equal(hits(`function a(xs, row) {
    const d = new Date();
    return xs.map(() => { const d = row.due_on; return d.toISOString().slice(0, 10); });
  }`), 0);
});

/**
 * The audit log must actually record what it is asked to record.
 *
 * Two independent silent failures were losing rows:
 *
 *   1. `action` is an ENUM. It listed CREATE, UPDATE and DELETE; the code passes
 *      ten more. MySQL rejected each insert and logActivity swallowed the error,
 *      so all 4,020 rows on the live database are one of those three. "Who
 *      confirmed this lease?" was reported as answerable and was not.
 *
 *   2. Twelve call sites pass an options object. logActivity took positional
 *      arguments only, so `entityType` bound to undefined and every one of those
 *      inserts violated NOT NULL. No INQUIRY, LEASE_TEMPLATE or SIGNATURE_REQUEST
 *      row has ever existed.
 *
 * Neither surfaced in a test because neither broke a request. These tests fail on
 * the source and on the behaviour, without needing a database.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { logActivity, ACTIONS } = require('../src/utils/activityLog');

// Line comments FIRST — a // comment containing "/*" otherwise opens a phantom
// block comment and swallows real code.
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// A req whose pool records the insert instead of running it.
function fakeReq(overrides = {}) {
  const calls = [];
  const req = {
    pool: { execute: async (sql, params) => { calls.push({ sql, params }); return [{}]; } },
    user: { orgId: '8300127259922432', id: '123', username: 'alex' },
    headers: {},
    connection: {},
    ...overrides,
  };
  return { req, calls };
}
const captured = (calls) => {
  const p = calls[0].params;
  return { orgId: p[0], userId: p[1], username: p[2], action: p[3],
           entityType: p[4], entityId: p[5], description: p[6], details: p[7] };
};

// ── the two lists must agree ────────────────────────────────────────────────

function enumValues() {
  const sql = readSrc('../migrations-org/081_activity_log_action_values.sql');
  const block = sql.match(/MODIFY action ENUM\(([\s\S]*?)\)\s*COLLATE/);
  assert.ok(block, 'the migration must widen the enum');
  return [...block[1].matchAll(/''([A-Z_]+)''/g)].map(m => m[1]);
}

test('ACTIONS matches the activity_log enum exactly', () => {
  assert.deepStrictEqual([...enumValues()].sort(), [...ACTIONS].sort(),
    'a value in one and not the other is a row the log will silently refuse');
});

test('the three original values keep their positions in the enum', () => {
  // MySQL stores an enum as the ordinal of its value. Reordering the first three
  // would silently change the meaning of all 4,020 existing rows: a row written
  // as CREATE would read back as whatever now sits first. Membership alone does
  // not catch that, so assert the positions.
  assert.deepStrictEqual(enumValues().slice(0, 3), ['CREATE', 'UPDATE', 'DELETE']);
  assert.deepStrictEqual(ACTIONS.slice(0, 3), ['CREATE', 'UPDATE', 'DELETE']);
});

// Extract the action from every logActivity call by walking the argument list
// with a brace/paren/quote counter.
//
// The first attempt matched /logActivity\(\s*[^,]+,\s*'([A-Z_]+)'/ and MISSED
// inquiry.js:523, whose first argument is a multi-line shim object full of commas.
// That call passes 'MERGE', which was therefore absent from both ACTIONS and the
// enum — the exact defect this test exists to catch, waved through by a scanner
// too weak to see it. A floor of `used.size >= 13` then let the suite pass.
function actionsUsedInSource() {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
    }
  })(path.join(__dirname, '../src'));

  const used = new Set();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let at = src.indexOf('logActivity(');
    while (at !== -1) {
      const args = splitArgs(src, at + 'logActivity('.length);
      if (args.length >= 2) {
        const second = args[1].trim();
        const positional = second.match(/^'([A-Z_]+)'$/);
        const objectForm = second.match(/action:\s*'([A-Z_]+)'/);
        if (positional) used.add(positional[1]);
        else if (objectForm) used.add(objectForm[1]);
      }
      at = src.indexOf('logActivity(', at + 1);
    }
  }
  return used;
}

// Split the argument list starting just after the opening paren, respecting
// nesting and quotes. Returns raw argument text.
function splitArgs(src, from) {
  const args = [];
  let depth = 0, quote = null, current = '';
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += src[++i] || ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('([{'.includes(ch)) { depth++; current += ch; continue; }
    if (ch === ')' && depth === 0) { args.push(current); return args; }
    if (')]}'.includes(ch)) { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += ch;
  }
  return args;
}

test('the scanner sees a call whose first argument is a multi-line object', () => {
  // The canary for the miss described above. inquiry.js passes a shim object
  // spanning lines, and 'MERGE' must still be found.
  assert.ok(actionsUsedInSource().has('MERGE'),
    'the scanner must not be defeated by commas inside the first argument');
});

test('every action the code passes is in ACTIONS', () => {
  const used = actionsUsedInSource();
  const unknown = [...used].filter(a => !ACTIONS.includes(a));
  assert.deepStrictEqual(unknown, [],
    'these would be rejected by the enum and lost: ' + unknown.join(', '));
});

test('ACTIONS carries no value the code never passes', () => {
  // A stale entry is a smaller problem than a missing one, but it means the list
  // and the code have drifted, and drift in this direction hides drift in the other.
  const used = actionsUsedInSource();
  const unused = ACTIONS.filter(a => !used.has(a));
  assert.deepStrictEqual(unused, [], 'in ACTIONS but never used: ' + unused.join(', '));
});

// ── both call shapes ────────────────────────────────────────────────────────

test('the positional form still works', async () => {
  const { req, calls } = fakeReq();
  await logActivity(req, 'CREATE', 'lease', '999', 'Created lease LEA1234');
  assert.strictEqual(calls.length, 1);
  const c = captured(calls);
  assert.strictEqual(c.action, 'CREATE');
  assert.strictEqual(c.entityType, 'lease');
  assert.strictEqual(c.entityId, '999');
  assert.strictEqual(c.description, 'Created lease LEA1234');
});

test('the object form is accepted rather than binding entityType to undefined', async () => {
  // Exactly the shape inquiry.js:670 uses.
  const { req, calls } = fakeReq();
  await logActivity(req, { action: 'CREATE', entityType: 'INQUIRY', entityId: '555' });
  assert.strictEqual(calls.length, 1, 'the row must be written, not dropped');
  const c = captured(calls);
  assert.strictEqual(c.action, 'CREATE');
  assert.strictEqual(c.entityType, 'INQUIRY');
  assert.strictEqual(c.entityId, '555');
});

test('the object form also accepts snake_case keys', async () => {
  const { req, calls } = fakeReq();
  await logActivity(req, { action: 'UPDATE', entity_type: 'INQUIRY', entity_id: '7' });
  assert.strictEqual(captured(calls).entityType, 'INQUIRY');
  assert.strictEqual(captured(calls).entityId, '7');
});

test('every action in ACTIONS actually reaches the insert', async () => {
  for (const action of ACTIONS) {
    const { req, calls } = fakeReq();
    await logActivity(req, action, 'lease', '1', 'x');
    assert.strictEqual(calls.length, 1, `${action} was dropped`);
    assert.strictEqual(captured(calls).action, action);
  }
});

// ── loud, not silent ────────────────────────────────────────────────────────

test('an unknown action is refused loudly and names the record', async () => {
  const { req, calls } = fakeReq();
  const said = [];
  const real = console.error;
  console.error = (...a) => said.push(a.join(' '));
  try {
    await logActivity(req, 'FROBNICATE', 'lease', '42', 'x');
  } finally { console.error = real; }
  assert.strictEqual(calls.length, 0, 'the enum would reject it — do not try');
  const line = said.join(' ');
  assert.match(line, /AUDIT ROW LOST/, 'the line must be searchable');
  assert.match(line, /FROBNICATE/, 'and name the action');
  assert.match(line, /42/, 'and name the record');
});

test('a failing insert is reported with the action and entity, not just a message', async () => {
  const { req } = fakeReq({ pool: { execute: async () => { throw new Error('Data truncated'); } } });
  const said = [];
  const real = console.error;
  console.error = (...a) => said.push(a.join(' '));
  try {
    await logActivity(req, 'CONFIRM', 'lease', '77', 'Confirmed');
  } finally { console.error = real; }
  const line = said.join(' ');
  assert.match(line, /AUDIT ROW LOST/);
  assert.match(line, /CONFIRM/);
  assert.match(line, /77/);
  assert.match(line, /Data truncated/);
});

test('a logging failure never breaks the request', async () => {
  const { req } = fakeReq({ pool: { execute: async () => { throw new Error('boom'); } } });
  const real = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(logActivity(req, 'CREATE', 'lease', '1', 'x'));
  } finally { console.error = real; }
});

// ── the other silent row-losers ─────────────────────────────────────────────

test('an over-long description is trimmed rather than losing the whole row', async () => {
  const { req, calls } = fakeReq();
  await logActivity(req, 'UPDATE', 'lease', '1', 'x'.repeat(900));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(captured(calls).description.length, 500,
    'description is varchar(500); strict mode rejects the insert instead of shortening it');
});

test('entity_type and entity_id are trimmed to their columns', async () => {
  const { req, calls } = fakeReq();
  await logActivity(req, 'UPDATE', 'e'.repeat(80), 'i'.repeat(80), 'x');
  assert.strictEqual(captured(calls).entityType.length, 50);
  assert.strictEqual(captured(calls).entityId.length, 50);
});

test('no signed-in user means no row, and stays quiet about it', async () => {
  // user_id is NOT NULL. Public routes would otherwise fill the log with noise.
  const { req, calls } = fakeReq({ user: undefined });
  const said = [];
  const real = console.error;
  console.error = (...a) => said.push(a.join(' '));
  try { await logActivity(req, 'CREATE', 'lease', '1', 'x'); } finally { console.error = real; }
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(said.length, 0);
});

test('the util no longer prints an anonymous "Activity log error"', () => {
  const src = stripComments(readSrc('../src/utils/activityLog.js'));
  assert.doesNotMatch(src, /console\.error\('Activity log error:'/,
    'that line is what let an enum rejecting ten values go unnoticed');
});

// ── the remaining silent row-losers ─────────────────────────────────────────

test('a missing entityType is refused loudly, not sent to a NOT NULL column', async () => {
  // Passing null here would fail the insert and land in the catch — the same
  // silent loss, one layer down.
  const { req, calls } = fakeReq();
  const said = [];
  const real = console.error;
  console.error = (...a) => said.push(a.join(' '));
  try { await logActivity(req, 'CREATE', null, '5', 'x'); } finally { console.error = real; }
  assert.strictEqual(calls.length, 0);
  assert.match(said.join(' '), /AUDIT ROW LOST — missing entityType/);
});

test('trimming lands on a character boundary, not mid-emoji', () => {
  // VARCHAR(50) counts characters; String.slice counts UTF-16 code units, so a
  // naive slice can cut a surrogate pair in half and store a lone surrogate.
  // 600 emoji is 600 CHARACTERS (1200 UTF-16 units), so it genuinely overflows
  // VARCHAR(500). 400 would not: it is 800 code units but only 400 characters,
  // and trimming it at all would be the bug.
  const { req, calls } = fakeReq();
  return logActivity(req, 'UPDATE', 'lease', '1', '😀'.repeat(600)).then(() => {
    const d = captured(calls).description;
    assert.strictEqual(Array.from(d).length, 500, 'trimmed by characters');
    assert.ok(!/[\uD800-\uDBFF]$/.test(d), 'must not end on a lone high surrogate');
  });
});

test('text shorter than the limit is passed through untouched', async () => {
  const { req, calls } = fakeReq();
  await logActivity(req, 'UPDATE', 'lease', '1', 'Renewed to 2027');
  assert.strictEqual(captured(calls).description, 'Renewed to 2027');
});

test('circular details lose the row but never throw into the request', async () => {
  const circular = { a: 1 };
  circular.self = circular;
  const { req } = fakeReq();
  const real = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(logActivity(req, 'UPDATE', 'lease', '1', 'x', circular));
  } finally { console.error = real; }
});

test('a circular action cannot make the error logger itself throw', async () => {
  // The catch stringifies what it was given. If that throws, the failure escapes
  // into the request — the one thing logging must never do.
  const weird = { toString() { throw new Error('nope'); } };
  weird.self = weird;
  const { req } = fakeReq();
  const real = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(logActivity(req, weird, 'lease', '1', 'x'));
  } finally { console.error = real; }
});

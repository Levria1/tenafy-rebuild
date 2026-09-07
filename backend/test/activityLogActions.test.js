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

test('ACTIONS matches the activity_log enum exactly', () => {
  const sql = readSrc('../migrations-org/081_activity_log_action_values.sql');
  const block = sql.match(/MODIFY action ENUM\(([\s\S]*?)\)\s*COLLATE/);
  assert.ok(block, 'the migration must widen the enum');
  const inEnum = [...block[1].matchAll(/''([A-Z_]+)''/g)].map(m => m[1]);
  assert.deepStrictEqual([...inEnum].sort(), [...ACTIONS].sort(),
    'a value in one and not the other is a row the log will silently refuse');
});

test('every action the code passes is in ACTIONS', () => {
  const dir = path.join(__dirname, '../src');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
    }
  })(dir);

  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // positional: logActivity(req, 'ACTION', ...
    for (const m of src.matchAll(/logActivity\s*\(\s*[^,]+,\s*'([A-Z_]+)'/g)) used.add(m[1]);
    // object: logActivity(req, { action: 'ACTION', ...
    for (const m of src.matchAll(/logActivity\s*\(\s*[^,]+,\s*\{\s*action:\s*'([A-Z_]+)'/g)) used.add(m[1]);
  }

  assert.ok(used.size >= 13, `expected the real call sites, found ${used.size}`);
  const unknown = [...used].filter(a => !ACTIONS.includes(a));
  assert.deepStrictEqual(unknown, [],
    'these would be rejected by the enum and lost: ' + unknown.join(', '));
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

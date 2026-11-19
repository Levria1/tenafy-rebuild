/**
 * The tenant's renewal answer (leasing.renewal_reply) must not outlive the end date it
 * was given about.
 *
 * Real case, 2026-11-19: a tenant answered a renewal ask "Hi yes" in September, which
 * was recorded as Extend (1). Staff then moved the SAME lease row's end date out two
 * months. Extend stayed on the lease, so when the tenant later gave notice for the new
 * end date the unit was still withheld from every customer-facing path (chatbot,
 * Facebook posting). Nothing cleared the mark and staff had no way to change it.
 *
 * Three rules, one test group each:
 *   1. changing a lease's end date clears the answer (and only an actual change does);
 *   2. recording a move-out sets Leaving, and undoing it withdraws that Leaving;
 *   3. staff can set or clear the answer themselves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const router = require('../src/routes/leasing');
const { endDateChanged } = router;

const ORG = '9';
const LEASE = '7';

function handler(method, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} is not defined`);
  return layer.route.stack.at(-1).handle;
}

function call(fn, { pool, params = { id: LEASE }, body = {} }) {
  return new Promise((resolve, reject) => {
    // No user.id: logActivity returns early instead of writing an audit row.
    const req = { params, body, pool, user: { orgId: ORG }, headers: {}, query: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ statusCode: this.statusCode, body: b }); },
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}

// Every statement is recorded; the first matching handler answers. Anything unmatched
// reads as "no rows" (SELECT) or "one row changed" (writes).
function fakeDb(handlers = []) {
  const calls = [];
  // `via` tells a statement run on the transaction's connection from one run on the pool.
  const run = (via) => async (sql, params = []) => {
    calls.push({ sql, params, via });
    for (const [pattern, fn] of handlers) {
      if (pattern.test(sql)) return fn(params, sql);
    }
    return /^\s*(UPDATE|INSERT|DELETE)/i.test(sql) ? [{ affectedRows: 1 }] : [[]];
  };
  const execute = run('pool');
  const conn = {
    execute: run('conn'),
    beginTransaction: async () => { calls.push({ sql: 'BEGIN' }); },
    commit: async () => { calls.push({ sql: 'COMMIT' }); },
    rollback: async () => { calls.push({ sql: 'ROLLBACK' }); },
    release: () => {},
  };
  return { calls, execute, getConnection: async () => conn };
}

const OWNED = [/SELECT l\.id FROM leasing l/, () => [[{ id: LEASE }]]];
const isReplyWrite = (c) => /SET l\.renewal_reply = \?, l\.renewal_reply_at = \?/.test(c.sql);

// ── 1. A new end date clears the answer ─────────────────────────────────────

function editPool({ storedEnd = '2026-10-21', updateError = null } = {}) {
  let failedOnce = false;
  return fakeDb([
    OWNED,
    [/SELECT unit_id, start_date, end_date FROM leasing WHERE id = \?/, () => [[{ unit_id: '5', start_date: '2025-10-22', end_date: storedEnd }]]],
    [/SELECT DATE_FORMAT\(l\.end_date, '%Y-%m-%d'\) AS end_date/, () => [[{ end_date: storedEnd }]]],
    [/^UPDATE leasing SET /, (p, sql) => {
      if (updateError && !failedOnce && /renewal_reply/.test(sql)) { failedOnce = true; throw updateError; }
      return [{ affectedRows: 1 }];
    }],
  ]);
}
const leaseUpdates = (pool) => pool.calls.filter(c => /^UPDATE leasing SET /.test(c.sql));

test('moving the end date clears the renewal answer in the same statement', async () => {
  // The 5A shape: lease ran to 21 Oct, staff extend the same row to 21 Dec.
  const pool = editPool({ storedEnd: '2026-10-21' });
  const r = await call(handler('put', '/:id'), { pool, body: { end_date: '2026-12-21', price: 9000 } });
  assert.equal(r.statusCode, 200);
  const updates = leaseUpdates(pool);
  assert.equal(updates.length, 1, 'one UPDATE, so the date and the answer can never disagree');
  assert.match(updates[0].sql, /end_date = \?/);
  assert.match(updates[0].sql, /renewal_reply = NULL/);
  assert.match(updates[0].sql, /renewal_reply_at = NULL/);
  assert.ok(updates[0].params.includes('2026-12-21'));
});

test('shortening the end date clears it too', async () => {
  const pool = editPool({ storedEnd: '2026-12-21' });
  await call(handler('put', '/:id'), { pool, body: { end_date: '2026-11-30' } });
  assert.match(leaseUpdates(pool)[0].sql, /renewal_reply = NULL/);
});

test('a save that resends the SAME end date leaves the answer alone', async () => {
  // The edit page sends end_date on every save. Clearing here would put a staying
  // tenant's unit back in front of customers and re-open the ask sequence.
  const pool = editPool({ storedEnd: '2026-12-21' });
  const r = await call(handler('put', '/:id'), { pool, body: { end_date: '2026-12-21', price: 9500 } });
  assert.equal(r.statusCode, 200);
  const updates = leaseUpdates(pool);
  assert.equal(updates.length, 1);
  assert.doesNotMatch(updates[0].sql, /renewal_reply/);
});

test('an edit with no end date in it leaves the answer alone', async () => {
  const pool = editPool();
  await call(handler('put', '/:id'), { pool, body: { note: 'keys with concierge' } });
  assert.doesNotMatch(leaseUpdates(pool)[0].sql, /renewal_reply/);
});

test('an org without the renewal_reply column can still edit a lease', async () => {
  const err = Object.assign(new Error("Unknown column 'renewal_reply' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
  const pool = editPool({ storedEnd: '2026-10-21', updateError: err });
  const r = await call(handler('put', '/:id'), { pool, body: { end_date: '2026-12-21' } });
  assert.equal(r.statusCode, 200);
  const updates = leaseUpdates(pool);
  assert.equal(updates.length, 2, 'retried once without the renewal columns');
  assert.doesNotMatch(updates[1].sql, /renewal_reply/);
  assert.match(updates[1].sql, /end_date = \?/);
});

test('endDateChanged compares calendar days, whatever shape they arrive in', () => {
  assert.equal(endDateChanged('2026-12-21', '2026-12-21'), false);
  assert.equal(endDateChanged(new Date(2026, 11, 21), '2026-12-21'), false, 'mysql2 DATE as a local Date');
  assert.equal(endDateChanged('2026-12-21', '2026-12-21T00:00:00.000Z'), false);
  assert.equal(endDateChanged(null, ''), false, 'open-ended stays open-ended');
  assert.equal(endDateChanged('2026-10-21', '2026-12-21'), true);
  assert.equal(endDateChanged('2026-10-21', null), true, 'made open-ended');
  assert.equal(endDateChanged(null, '2026-12-21'), true, 'given an end');
});

// ── 2. A recorded move-out is a Leaving answer ──────────────────────────────

function moveOutPool() {
  return fakeDb([
    [/FOR UPDATE/, () => [[{ id: LEASE, end_date: '2026-12-21', start_date: '2025-10-22', tenant_id: '77', unit_id: '5', property_id: '3' }]]],
  ]);
}

test('recording a move-out sets Leaving, inside the move-out transaction', async () => {
  const pool = moveOutPool();
  const r = await call(handler('post', '/:id/move-out'), { pool, body: { move_out_date: '2026-12-21' } });
  assert.equal(r.statusCode, 200);
  const write = pool.calls.find(isReplyWrite);
  assert.ok(write, 'the move-out must write the answer');
  assert.equal(write.params[0], 2, 'Leaving');
  assert.match(String(write.params[1]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'stamped with the org wall clock');
  assert.deepEqual(write.params.slice(2), [LEASE, ORG], 'org-scoped');
  assert.match(write.sql, /p\.org_id = \?/);
  const order = pool.calls.map(c => c.sql);
  assert.ok(order.indexOf(write.sql) < order.indexOf('COMMIT'), 'written before the commit');
  assert.ok(order.indexOf('BEGIN') < order.indexOf(write.sql), 'written after the transaction opens');
  assert.equal(write.via, 'conn', 'on the transaction, not the pool');
});

test('undoing a move-out withdraws the Leaving it recorded, and only that', async () => {
  const pool = fakeDb([
    [/FOR UPDATE/, () => [[{ id: LEASE, end_date: '2026-12-21' }]]],
    [/FROM lease_moveout_request/, () => [[{ original_end_date: '2027-01-21' }]]],
    [/SELECT COUNT\(\*\) AS cnt FROM invoice/, () => [[{ cnt: 0 }]]],
  ]);
  const r = await call(handler('post', '/:id/move-out/undo'), { pool });
  assert.equal(r.statusCode, 200);
  const write = pool.calls.find(isReplyWrite);
  assert.ok(write, 'the undo must withdraw the answer');
  assert.deepEqual(write.params, [null, null, LEASE, ORG, 2],
    'back to NULL, and only on a lease still holding Leaving');
  assert.match(write.sql, /AND l\.renewal_reply = \?$/);
  const order = pool.calls.map(c => c.sql);
  assert.ok(order.indexOf(write.sql) < order.indexOf('COMMIT'));
  assert.equal(write.via, 'conn', 'on the transaction, not the pool');
});

// ── 3. Staff can set or clear the answer ────────────────────────────────────

// Looked up per call, so a missing route fails each test by name rather than the file.
const setReply = (req, res) => handler('put', '/:id/renewal-reply')(req, res);

test('staff can replace a stale Extend with Leaving', async () => {
  const pool = fakeDb([OWNED]);
  const r = await call(setReply, { pool, body: { reply: 'leaving' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.renewal_reply, 2);
  const write = pool.calls.find(isReplyWrite);
  assert.equal(write.params[0], 2);
  assert.ok(write.params[1], 'stamped');
  assert.deepEqual(write.params.slice(2), [LEASE, ORG]);
  assert.match(write.sql, /p\.org_id = \?/);
});

test('staff can clear the answer, which also clears its timestamp', async () => {
  const pool = fakeDb([OWNED]);
  const r = await call(setReply, { pool, body: { reply: null } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.renewal_reply, null);
  assert.deepEqual(pool.calls.find(isReplyWrite).params, [null, null, LEASE, ORG]);
});

test('extend and unsure map to their codes', async () => {
  for (const [name, code] of [['extend', 1], ['Unsure', 3]]) {
    const pool = fakeDb([OWNED]);
    await call(setReply, { pool, body: { reply: name } });
    assert.equal(pool.calls.find(isReplyWrite).params[0], code, name);
  }
});

test('an unknown answer is refused and writes nothing', async () => {
  for (const reply of ['yes', 4, 'staying please', undefined, 'constructor', '__proto__', 'toString']) {
    const pool = fakeDb([OWNED]);
    const r = await call(setReply, { pool, body: { reply } });
    assert.equal(r.statusCode, 400, String(reply));
    assert.equal(pool.calls.filter(isReplyWrite).length, 0);
  }
});

test("another org's lease is not found and is not written", async () => {
  const pool = fakeDb([[/SELECT l\.id FROM leasing l/, () => [[]]]]);
  const r = await call(setReply, { pool, body: { reply: 'leaving' } });
  assert.equal(r.statusCode, 404);
  assert.equal(pool.calls.filter(isReplyWrite).length, 0);
});

test('setting the answer needs the lease-edit permission', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/leasing.js'), 'utf8');
  assert.ok(src.includes(
    "router.put('/:id/renewal-reply', authenticate, requirePermission('LANDLORD/LEASING_EDIT')"));
});

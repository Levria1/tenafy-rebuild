const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const router = require('../src/routes/utility');
const { decideCorrection } = require('../src/utils/meterReading');

function handler(method, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(pool, { params = {}, body = {}, query = {} } = {}) {
  return { pool, params, body, query, user: { orgId: 'org-1', username: 'staff' }, headers: {}, connection: {} };
}

function transaction(execute) {
  const state = { begun: 0, committed: 0, rolledBack: 0, released: 0, calls: [] };
  const conn = {
    async beginTransaction() { state.begun++; },
    async commit() { state.committed++; },
    async rollback() { state.rolledBack++; },
    release() { state.released++; },
    async execute(sql, params) { state.calls.push({ sql, params }); return execute(sql, params); },
  };
  return { state, pool: { getConnection: async () => conn } };
}

test('bill delete removes only its readings and resets each meter to newest remaining', async () => {
  const tx = transaction(async (sql, params) => {
    if (/SELECT status FROM utility_bill/.test(sql)) return [[{ status: 1 }]];
    if (/COUNT\(\*\).*utility_bill_line/s.test(sql)) return [[{ cnt: 0 }]];
    if (/SELECT DISTINCT bl\.meter_id/.test(sql)) return [[{ meter_id: 'meter-1' }]];
    if (/DELETE FROM utility_meter_reading/.test(sql)) {
      assert.deepEqual(params, ['bill-1', 'org-1']);
      return [{ affectedRows: 2 }];
    }
    if (/SELECT reading_value FROM utility_meter_reading/.test(sql)) return [[{ reading_value: '123.45' }]];
    return [{ affectedRows: 1 }];
  });
  const res = response();
  await handler('delete', '/bill/:id')(request(tx.pool, { params: { id: 'bill-1' } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /2 reading\(s\) removed/);
  const reset = tx.state.calls.find(c => /UPDATE utility_meter SET current_reading/.test(c.sql));
  assert.deepEqual(reset.params, ['123.45', 'meter-1', 'org-1']);
  assert.equal(tx.state.committed, 1);
  assert.equal(tx.state.released, 1);
});

test('bill delete leaves current_reading unchanged when no reading remains', async () => {
  const tx = transaction(async sql => {
    if (/SELECT status FROM utility_bill/.test(sql)) return [[{ status: 1 }]];
    if (/COUNT\(\*\).*utility_bill_line/s.test(sql)) return [[{ cnt: 0 }]];
    if (/SELECT DISTINCT bl\.meter_id/.test(sql)) return [[{ meter_id: 'meter-1' }]];
    if (/DELETE FROM utility_meter_reading/.test(sql)) return [{ affectedRows: 1 }];
    if (/SELECT reading_value FROM utility_meter_reading/.test(sql)) return [[undefined]];
    return [{ affectedRows: 1 }];
  });
  const res = response();
  await handler('delete', '/bill/:id')(request(tx.pool, { params: { id: 'bill-1' } }), res);
  assert.equal(tx.state.calls.some(c => /UPDATE utility_meter SET current_reading/.test(c.sql)), false);
});

test('bill delete invoice guard still blocks and rolls back', async () => {
  const tx = transaction(async sql => /SELECT status/.test(sql) ? [[{ status: 1 }]] : [[{ cnt: 1 }]]);
  const res = response();
  await handler('delete', '/bill/:id')(request(tx.pool, { params: { id: 'bill-1' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /active invoice/);
  assert.equal(tx.state.committed, 0);
  assert.equal(tx.state.rolledBack, 1);
});

test('single reading delete refuses an active bill invoice', async () => {
  const tx = transaction(async sql => {
    if (/FROM utility_meter_reading WHERE id/.test(sql)) return [[{ id: 'r1', meter_id: 'm1', reading_value: 9, reading_date: '2026-09-01', bill_id: 'b1' }]];
    return [[{ cnt: 1 }]];
  });
  const res = response();
  await handler('delete', '/meter-reading/:id')(request(tx.pool, { params: { id: 'r1' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Delete the invoice and bill first/);
});

test('single reading delete recomputes current reading', async () => {
  const tx = transaction(async sql => {
    if (/FROM utility_meter_reading WHERE id/.test(sql)) return [[{ id: 'r1', meter_id: 'm1', reading_value: 9, reading_date: '2026-09-01', bill_id: null }]];
    if (/SELECT reading_value FROM utility_meter_reading/.test(sql)) return [[{ reading_value: 8 }]];
    return [{ affectedRows: 1 }];
  });
  const res = response();
  await handler('delete', '/meter-reading/:id')(request(tx.pool, { params: { id: 'r1' } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(tx.state.calls.some(c => /UPDATE utility_meter SET current_reading/.test(c.sql) && c.params[0] === 8));
  assert.equal(tx.state.committed, 1);
});

test('single reading delete returns 404 for another org reading', async () => {
  // The reading exists, but belongs to org-2. A lookup that is not scoped by the
  // caller's org would find it and go on to delete another organisation's data.
  const foreign = { id: 'foreign', meter_id: 'm9', reading_value: 5, reading_date: '2026-01-01', bill_id: null, org_id: 'org-2' };
  const tx = transaction(async (sql, params) => {
    if (/FROM utility_meter_reading WHERE id = \?/.test(sql)) {
      const scoped = /org_id = \?/.test(sql);
      return [[scoped && params.includes('org-1') ? undefined : foreign]];
    }
    return [[undefined]];
  });
  const res = response();
  await handler('delete', '/meter-reading/:id')(request(tx.pool, { params: { id: 'foreign' } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(tx.state.rolledBack, 1);
});

test('future-dated manual reading is rejected', async () => {
  const pool = { execute: async sql => {
    if (/FROM utility_meter WHERE/.test(sql)) return [[{ id: 'm1', current_reading: 1 }]];
    return [[{ reading_value: 1 }]];
  } };
  const res = response();
  await handler('post', '/meter-reading')(request(pool, { body: { meter_id: 'm1', reading_value: 2, reading_date: '2999-01-01' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Reading date cannot be in the future');
});

test('finalize rejects a bill whose period ends in the future', async () => {
  let calls = 0;
  const pool = { execute: async () => { calls++; return [[{ id: 'b1', status: 0, period_end: '2999-01-01' }]]; } };
  const res = response();
  await handler('post', '/bill/:id/finalize')(request(pool, { params: { id: 'b1' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /period ends on 2999-01-01/);
  assert.equal(calls, 1);
});

test('correction decision blocks a later-dated reading with its date and value', () => {
  assert.deepEqual(decideCorrection({
    latestReading: { reading_value: '77', reading_date: '2026-10-28' },
    submitted: 70, today: '2026-10-02',
  }), { action: 'blocked-future', shown: 77, date: '2026-10-28', value: '77' });
});

test('duplicate same-day correction is not inserted', async () => {
  const tx = transaction(async sql => {
    if (/FROM utility_meter WHERE/.test(sql)) return [[{ id: 'm1', current_reading: 10 }]];
    if (/SELECT reading_value, reading_date/.test(sql)) return [[{ reading_value: 10, reading_date: '2026-01-01' }]];
    if (/SELECT id FROM utility_meter_reading/.test(sql)) return [[{ id: 'existing' }]];
    return [{ affectedRows: 1 }];
  });
  const res = response();
  await handler('put', '/meter/:id')(request(tx.pool, { params: { id: 'm1' }, body: { current_reading: 11 } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /already in Reading History/);
  assert.equal(tx.state.calls.some(c => /INSERT INTO utility_meter_reading/.test(c.sql)), false);
});

test('company tenant SQL falls back to the person name when company is blank', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/leasing.js'), 'utf8');
  // Every place that turns a company-type tenant into a display name must fall back
  // to the person's name; checking for one occurrence let any of the others regress.
  const branches = [...source.matchAll(/CASE\s+(?:WHEN t\.type = 1|t\.type WHEN 1)\s+THEN\s+([^\n]+)/g)];
  // Additional tenants now use the shared leaseTenants loader and the tested
  // personOrCompanyName helper; three SQL branches remain in this route.
  assert.ok(branches.length >= 3, `expected at least 3 company-name branches, found ${branches.length}`);
  for (const [, then] of branches) {
    assert.match(then, /^COALESCE\(NULLIF\(TRIM\(t\.company_name\), ''\), TRIM\(CONCAT\(COALESCE\(t\.first_name/);
  }
  assert.doesNotMatch(source, /lease\.company_name \|\| 'Company'/);
});

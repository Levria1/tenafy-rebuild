const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// "I can't attach/upload a file in the invoice portion": the invoice upload box
// threw the file away and the drawer printed a hard-coded "—". Invoice files now
// use the same object_file link as payment receipts.

const ORG = 'org1';
const MY_FILE = '1780000000000000001';
const OTHER_ORG_FILE = '1780000000000000002';

function fakePool({ invoiceExists = true, linked = [] } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT CAST\(id AS CHAR\) AS id FROM file/.test(sql)) {
        // Only files owned by the caller's org come back.
        return [params.slice(0, -1).filter(id => id === MY_FILE).map(id => ({ id }))];
      }
      if (/COUNT\(\*\) AS n FROM object_file/.test(sql)) return [[{ n: '0' }]];
      if (/FROM object_file objf/.test(sql)) {
        const objectId = params[0];
        return [linked.filter(l => l.object_id === objectId).map(l => ({
          id: l.file_id, filename: 'lease.pdf', item_name: 'x', mime_type: 'APPLICATION/PDF',
          file_size: '2048', attached_at: '2026-11-03 10:00:00',
        }))];
      }
      if (/SELECT id FROM invoice WHERE id = \? AND org_id = \?/.test(sql)) {
        return [invoiceExists ? [{ id: params[0] }] : []];
      }
      if (/SELECT id FROM file WHERE id = \? AND org_id = \?/.test(sql)) {
        return [params[0] === MY_FILE ? [{ id: MY_FILE }] : []];
      }
      if (/UPDATE object_file SET deleted_at/.test(sql)) {
        const hit = linked.some(l => l.object_id === params[0] && l.file_id === params[1]);
        return [{ affectedRows: hit ? 1 : 0 }];
      }
      if (/FROM invoice i\s/.test(sql)) {
        return [[{ id: 'inv1', invoice_code: 'TRIV1', amount: '100.00', status: 0 }]];
      }
      if (/FROM accounting_line al\s+JOIN accounting a/.test(sql) && /DISTINCT/.test(sql)) {
        return [[{ id: 'pay1', amount: '40.00' }]];
      }
      if (/SELECT id FROM category_setting|FROM currency/.test(sql)) return [[{ id: 'c1' }]];
      return [[]];
    },
  };
}

function loadRouter(pool) {
  const stub = (rel, exports) => {
    const id = require.resolve(rel);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('../src/middleware/auth', {
    authenticate: (req, res, next) => { req.user = { orgId: ORG, userId: 'u1' }; req.pool = pool; next(); },
    requirePermission: () => (req, res, next) => next(),
  });
  stub('../src/utils/activityLog', { logActivity: async () => {} });
  delete require.cache[require.resolve('../src/routes/invoice')];
  return require('../src/routes/invoice');
}

async function call(router, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/invoice', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  } finally { server.close(); }
}

const linksWritten = pool => pool.calls
  .filter(c => /INSERT INTO object_file/.test(c.sql))
  .map(c => c.params);

test('creating an invoice attaches the uploaded files and marks them private', async () => {
  const pool = fakePool();
  const res = await call(loadRouter(pool), 'POST', '/api/invoice', {
    tenant_id: 't1', amount: 100, due_date: '2026-11-10', invoice_code: 'TRIV1',
    file_ids: [MY_FILE],
  });
  assert.equal(res.status, 200);
  const invoiceId = res.data.data.id;
  assert.deepEqual(linksWritten(pool), [[invoiceId, MY_FILE]]);
  assert.ok(pool.calls.some(c => /UPDATE file SET is_private = 1/.test(c.sql) && c.params[0] === MY_FILE));
});

test('editing an invoice adds files, and never links another org\'s file', async () => {
  const pool = fakePool();
  const res = await call(loadRouter(pool), 'PUT', '/api/invoice/inv1', {
    note: 'x', file_ids: [MY_FILE, OTHER_ORG_FILE],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(linksWritten(pool), [['inv1', MY_FILE]]);
});

test('an edit that sends no file_ids detaches nothing', async () => {
  const pool = fakePool({ linked: [{ object_id: 'inv1', file_id: MY_FILE }] });
  const res = await call(loadRouter(pool), 'PUT', '/api/invoice/inv1', { note: 'x' });
  assert.equal(res.status, 200);
  assert.equal(pool.calls.some(c => /object_file SET deleted_at/.test(c.sql)), false);
});

test('invoice detail lists files on the invoice and on each payment', async () => {
  const pool = fakePool({ linked: [
    { object_id: 'inv1', file_id: MY_FILE },
    { object_id: 'pay1', file_id: '1780000000000000003' },
  ] });
  const res = await call(loadRouter(pool), 'GET', '/api/invoice/inv1');
  assert.equal(res.status, 200);
  const data = res.data.data;
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].id, MY_FILE);
  assert.equal(data.files[0].preview_url, `/api/file/preview/${MY_FILE}`);
  assert.equal(data.payments[0].files.length, 1);
});

test('detaching a file soft-deletes only that link', async () => {
  const pool = fakePool({ linked: [{ object_id: 'inv1', file_id: MY_FILE }] });
  const res = await call(loadRouter(pool), 'DELETE', `/api/invoice/inv1/file/${MY_FILE}`);
  assert.equal(res.status, 200);
  const del = pool.calls.find(c => /UPDATE object_file SET deleted_at/.test(c.sql));
  assert.deepEqual(del.params, ['inv1', MY_FILE]);
});

test('detach refuses another org\'s file or an unknown invoice', async () => {
  const other = await call(loadRouter(fakePool()), 'DELETE', `/api/invoice/inv1/file/${OTHER_ORG_FILE}`);
  assert.equal(other.status, 404);
  const missing = await call(loadRouter(fakePool({ invoiceExists: false })), 'DELETE', `/api/invoice/nope/file/${MY_FILE}`);
  assert.equal(missing.status, 404);
});

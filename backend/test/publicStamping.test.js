const test = require('node:test');
const assert = require('node:assert/strict');

function routeHandler(router, path, method = 'get') {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `missing route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader() {},
  };
}

function project(sql, row) {
  const kept = {};
  for (const [key, value] of Object.entries(row)) {
    if (new RegExp(`\\b${key}\\b`).test(sql)) kept[key] = value;
  }
  return kept;
}

function stampingPool(fixtures) {
  const calls = [];
  const pool = {
    calls,
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM leasing l\s+JOIN unit u/.test(sql)) {
        const orgId = params[1];
        const from = params[2];
        const rows = fixtures.leases
          .filter(l => String(l.org_id) === String(orgId))
          .filter(l => l.deleted_at == null)
          .filter(l => !l.end_date || l.end_date >= from)
          .map(row => project(sql, row));
        return [rows];
      }
      if (/FROM signature_request\s+WHERE org_id = \? AND lease_id IN/.test(sql)) {
        const orgId = params[0];
        const ids = new Set(params.slice(1).map(String));
        return [fixtures.documents.filter(d => String(d.org_id) === String(orgId) && ids.has(String(d.lease_id))).map(row => project(sql, row))];
      }
      if (/FROM signature_request sr/.test(sql)) {
        const [requestId, orgId, propertyOrgId] = params.map(String);
        const row = fixtures.contextRows.find(r => String(r.id) === requestId
          && String(r.org_id) === orgId
          && String(r.property_org_id) === propertyOrgId
          && Number(r.status) === 3
          && r.deleted_at == null);
        return [[row ? project(sql, row) : undefined]];
      }
      if (/FROM leasing_additional_tenant/.test(sql)) return [[]];
      if (/FROM lease_revision/.test(sql)) return [[]];
      if (/FROM file/.test(sql)) return [[fixtures.files && fixtures.files[params[0]]]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return pool;
}

test('stamping route 404s across org, unsigned status and deleted leases', async () => {
  const router = require('../src/routes/publicStamping');
  const handler = routeHandler(router, '/:request_id');
  const base = {
    id: 'req1', org_id: 'org1', property_org_id: 'org1', status: 3, lease_id: 'lease1',
    signature_method: 'esign', signed_file_id: null, term_start: '2026-10-17', term_end: '2027-10-16',
    completed_at: '2026-10-18', lease_no: 'LEA1', start_date: '2026-10-17', end_date: '2027-10-16',
    stamp_end_date: null, price: 19000, amount: null, invoicing: '30', credits: null,
    unit_id: 'unit1', unit_name: '5A', unit_account_name: null, property_id: 'prop1',
    property_name: 'Tai Yuen', street_address: 'Nam Pak Hong Building, 24 Bonham Strand West',
    district: 'Sheung Wan', landlord_name: 'ACJ Ventures Limited', landlord_br_no: 'BR1',
    tenant_id: 'tenant1', first_name: 'Ada', last_name: 'Lovelace', company_name: null,
    id_card: 'A1234563', id_type: 'hkid',
  };

  for (const override of [
    { property_org_id: 'other' },
    { status: 2 },
    { deleted_at: '2026-10-01' },
  ]) {
    const response = res();
    await handler(
      { params: { request_id: 'req1' }, apiKey: { orgId: 'org1' }, pool: stampingPool({ contextRows: [{ ...base, ...override }], leases: [], documents: [] }) },
      response
    );
    assert.equal(response.statusCode, 404);
  }
});

test('stamping queue returns only signed rows and excludes unsigned expired and OTA', async () => {
  const router = require('../src/routes/publicStamping');
  const handler = routeHandler(router, '/queue');
  const pool = stampingPool({
    contextRows: [],
    leases: [
      { id: '1', org_id: 'org1', lease_no: 'LEA1', start_date: '2026-10-01', end_date: '2027-09-30', lease_created_at: '2026-10-01', unit_name: '5A', property_name: 'A', tenant_name: 'Signed', platform_name: 'Direct', requires_signature: 1 },
      { id: '2', org_id: 'org1', lease_no: 'LEA2', start_date: '2026-10-01', end_date: '2027-09-30', lease_created_at: '2026-10-02', unit_name: '5B', property_name: 'A', tenant_name: 'Unsigned', platform_name: 'Direct', requires_signature: 1 },
      { id: '3', org_id: 'org1', lease_no: 'LEA3', start_date: '2026-10-01', end_date: '2027-09-30', lease_created_at: '2026-10-03', unit_name: '5C', property_name: 'A', tenant_name: 'OTA', platform_name: 'Airbnb', requires_signature: 0 },
      { id: '4', org_id: 'org1', lease_no: 'LEA4', start_date: '2026-10-01', end_date: '2027-09-30', lease_created_at: '2026-10-04', unit_name: '5D', property_name: 'A', tenant_name: 'Expired', platform_name: 'Direct', requires_signature: 1 },
    ],
    documents: [
      { id: 'r1', org_id: 'org1', lease_id: '1', status: 3, signature_method: 'paper', term_start: '2026-10-01', term_end: '2027-09-30', completed_at: '2026-10-04', created_at: '2026-10-04' },
      { id: 'r4', org_id: 'org1', lease_id: '4', status: 5, signature_method: 'esign', term_start: '2026-10-01', term_end: '2027-09-30', sent_at: '2026-10-04', created_at: '2026-10-04' },
    ],
  });
  const response = res();
  await handler({ query: { signed_since: '2026-01-01' }, apiKey: { orgId: 'org1' }, pool }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.from, '2026-09-01');
  assert.deepEqual(response.body.data.rows.map(r => r.request_id), ['r1']);
});

test('Smart Extract sets id_type from passport MRZ, HKID, or leaves junk absent', async () => {
  const tenantRouter = require('../src/routes/tenant');
  const llmClient = require('../src/services/llmClient');
  const handler = routeHandler(tenantRouter, '/parse', 'post');
  const original = llmClient.chat;
  try {
    llmClient.chat = async () => ({ message: { content: JSON.stringify({ id_card: 'A1234563' }) } });
    let response = res();
    await handler({ body: { text: 'Hong Kong Identity Card' } }, response);
    assert.equal(response.body.data.fields.id_type, 'hkid');

    llmClient.chat = async () => ({ message: { content: JSON.stringify({ id_card: 'not an id' }) } });
    response = res();
    await handler({ body: { text: 'junk' } }, response);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body.data.fields, 'id_type'), false);

    llmClient.chat = async () => ({ message: { content: '{}' } });
    response = res();
    await handler({ body: { text: 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10' } }, response);
    assert.equal(response.body.data.fields.id_type, 'passport');
  } finally {
    llmClient.chat = original;
  }
});

test('tenant update without id_type leaves the column untouched', async () => {
  const tenantRouter = require('../src/routes/tenant');
  const handler = routeHandler(tenantRouter, '/:id/profile', 'put');
  const pool = { execute: async (sql, params) => { pool.last = { sql, params }; return [{ affectedRows: 1 }]; }, query: async () => [[]] };
  const response = res();
  await handler({
    params: { id: 'tenant1' },
    body: { first_name: 'Ada', last_name: 'Lovelace', email: '', whatsapp_opt_out: 0, file_ids: [] },
    user: { orgId: 'org1' },
    pool,
  }, response);
  assert.match(pool.last.sql, /id_type = CASE WHEN \? = 1 THEN \? ELSE id_type END/);
  assert.equal(pool.last.params[11], 0);
  assert.equal(pool.last.params[12], null);
});

// The fake pool above filters in JavaScript and never reads the SQL, so on its own it
// cannot notice a predicate being deleted from the real query (verified 2026-10-09 by
// deleting each one: the suite stayed green). Pin the guards on the query itself, with
// comments stripped so a comment can never satisfy them. The org is checked twice —
// signature_request.org_id AND property.org_id — so losing one still leaks nothing,
// but each must stay.
test('stamping payload query keeps its org, status and deleted-lease guards', async () => {
  const router = require('../src/routes/publicStamping');
  const handler = routeHandler(router, '/:request_id');
  const seen = [];
  const pool = {
    execute: async (sql, params = []) => { seen.push({ sql, params }); return [[undefined]]; },
  };
  const response = res();
  await handler({ params: { request_id: 'req1' }, apiKey: { orgId: 'org1' }, pool }, response);
  assert.equal(response.statusCode, 404);
  const { sql, params } = seen[0];
  const bare = sql.replace(/--.*$/gm, '');
  assert.match(bare, /sr\.org_id = \?/);
  assert.match(bare, /p\.org_id = \?/);
  assert.match(bare, /sr\.status = 3/);
  assert.match(bare, /l\.deleted_at IS NULL/);
  assert.deepEqual(params.map(String), ['req1', 'org1', 'org1']);
});

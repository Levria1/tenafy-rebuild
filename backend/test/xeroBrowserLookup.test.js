const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const service = require('../src/services/xeroBrowserLookup');
const registry = require('../src/config/poolRegistry');
const ACCOUNT = '12345678-abcd-1234-abcd-123456789abc';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const input = () => ({ ui_org_slug: 'verified-org', xero_account_id: ACCOUNT,
  statement: { id_suffix: '1'.repeat(32), date: '2026-11-19', direction: 'received', currency: 'HKD', amount_minor: 1380000 } });

test('statement identity requires an exact date, currency, safe minor amount and strict UUID shape', () => {
  assert.equal(service.normalizeAccountId(ACCOUNT.toUpperCase()), ACCOUNT.replace(/-/g, ''));
  assert.equal(service.validateStatement(input().statement).amount, '13800.00');
  assert.equal(service.validateStatement({ ...input().statement, currency: 'JPY' }).amount, '1380000');
  for (const bad of [{ date: '2026-02-30' }, { date: '2026-13-01' }, { currency: '' }, { currency: 'ZZZ' },
    { currency: 'KWD' }, { amount_minor: 1.5 }, { amount_minor: '1380000' }, { amount_minor: 0 },
    { amount_minor: Number.MAX_SAFE_INTEGER + 1 }, { direction: 'in' }, { id_suffix: 'sl' + '1'.repeat(32) }, { reference: {} }]) {
    assert.throws(() => service.validateStatement({ ...input().statement, ...bad }), e => e.status === 400);
  }
  assert.throws(() => service.normalizeAccountId('1234-5678abcd1234abcd123456789abc'));
  assert.equal(service.decimalMinor('13800.00', 2), 1380000);
  assert.equal(service.decimalMinor('13800.001', 2), null);
});

test('mapping mismatches refuse lookup before financial or message queries', async () => {
  for (const mode of ['slug', 'reconnected', 'duplicate-bank', 'wrong-currency', 'missing-currency', 'duplicate-currency', 'rate-table-unbound']) {
    const calls = [];
    const pool = { execute: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM xero_browser_binding')) return [[{ ui_org_slug: mode === 'slug' ? 'other' : 'verified-org',
        xero_tenant_id: TENANT, connected_tenant_id: mode === 'reconnected' ? 'other' : TENANT }]];
      if (sql.includes('FROM xero_account_map')) return [[...Array(mode === 'duplicate-bank' ? 2 : 1)].map(() => ({ bank_account_id: '10', tenafy_account_setting_id: '20', currency: mode === 'wrong-currency' ? 'USD' : 'HKD' }))];
      if (sql.includes('FROM currency')) return [[...Array(mode === 'missing-currency' ? 0 : mode === 'duplicate-currency' ? 2 : 1)].map((_, i) => ({ id: String(i), detail: mode === 'rate-table-unbound' ? { HKD: 7.8, USD: 1 } : { code: 'HKD' } }))];
      throw Error('Financial query should not run');
    } };
    await assert.rejects(service.lookup(pool, '1', input()), e => e.status === 409);
    assert.ok(calls.every(sql => !/FROM (invoice|leasing|accounting|chat_message)\b/.test(sql)));
  }
});

test('HTTP lookup enforces staff authentication/permission and never trusts a request organisation', async t => {
  const calls = [];
  const pool = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*) AS messages')) return [[{ messages: 0, earliest: null, latest: null }]];
    if (sql.includes('password_changed_at')) return [[{ changed: null }]];
    if (sql.includes('FROM role_permission')) return [[]];
    if (sql.includes('FROM xero_browser_binding')) return params[0] === '1' ? [[{ ui_org_slug: 'verified-org', xero_tenant_id: TENANT, connected_tenant_id: TENANT }]] : [[]];
    if (sql.includes('FROM xero_account_map')) return [[{ bank_account_id: '10', tenafy_account_setting_id: '20', currency: 'HKD' }]];
    if (sql.includes('FROM currency')) return [[{ id: '30', detail: { code: 'HKD' } }]];
    if (sql.includes('FROM invoice i')) return [[{ id: '100', invoice_code: 'TEST-INV', amount: '13800', outstanding: '13800', first_name: 'Sample', last_name: 'Tenant', days_from_date: 0 }]];
    return [[]];
  } };
  let resolvedPools = 0;
  t.mock.method(registry, 'getMasterPool', () => ({ execute: async () => [[]] }));
  t.mock.method(registry, 'getOrgPool', async () => { resolvedPools++; return pool; });
  // auth destructures the pool resolver on first load.
  delete require.cache[require.resolve('../src/middleware/auth')];
  delete require.cache[require.resolve('../src/routes/xeroBrowser')];
  const app = express(); app.use(express.json()); app.use('/browser', require('../src/routes/xeroBrowser'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = async (claims, body = input(), path = '/lookup', method = 'POST') => {
    const token = claims ? jwt.sign({ id: '99', orgId: '1', ...claims }, config.jwtSecret, { expiresIn: '1m' }) : '';
    return fetch(`http://127.0.0.1:${server.address().port}/browser${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
  };
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(null, input(), '/history')).status, 401);
  assert.equal((await request({ permissions: [] }, input(), '/history')).status, 403);
  assert.equal((await request({ permissions: ['*'] }, {...input(), cursor: 'forged'}, '/history')).status, 400);
  assert.equal((await request({ permissions: ['*'] }, {...input(),lookback_days:365}, '/history')).status,400);
  const history = await request({ permissions: ['*'] }, {...input(), allowUnlinked:true, org_id:'2'}, '/history');
  assert.equal(history.status, 200);
  const historyData=(await history.json()).data;
  assert.equal(historyData.evidence.search_scope, 'retained_tenafy_history');
  assert.equal(historyData.evidence.unlinked_included,false,'Payload cannot enable unlinked access');
  assert.equal(historyData.identity.org_id,'1');
  assert.equal((await request({ permissions: [] })).status, 403);
  assert.equal((await request({ role: 'tenant', permissions: ['*'] })).status, 401);
  assert.equal((await request({ isMasterAdmin: true, permissions: ['*'] })).status, 403);
  assert.equal((await request({ orgId: '2', permissions: ['*'] }, { ...input(), org_id: '1' })).status, 409);
  assert.equal((await request({ permissions: ['*'] }, { ...input(), expected_org_id: '2' })).status, 409);
  const binding = await request({ permissions: ['*'] }, null, '/binding', 'GET');
  assert.equal((await binding.json()).data.org_id, '1');
  assert.equal((await request({ permissions: ['LANDLORD/ACCOUNTING_CREATE'] }, { ui_org_slug: 'verified-org' }, '/binding', 'PUT')).status, 403);
  assert.equal((await request({ permissions: ['LANDLORD/ACCOUNTING_CREATE'] }, { currency_id: '30', currency_code: 'HKD', confirm_invoice_lease_currency: true }, '/currency', 'PUT')).status, 403);
  const response = await request({ permissions: ['LANDLORD/ACCOUNTING_CREATE'] }, { ...input(), org_id: '2', bank_account_id: '999' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { data } = await response.json();
  assert.equal(data.identity.org_id, '1'); assert.equal(data.identity.bank_account_id, '10');
  assert.equal(data.candidates[0].id, '100'); assert.equal(data.candidates[0].outstanding_minor, 1380000);
  assert.deepEqual(data.capabilities, { read_only: true, live_autofill: false, final_confirmation: 'staff' });
  assert.ok(calls.every(c => /^\s*SELECT\b/.test(c.sql)));
  let commits = 0, rollbacks = 0;
  const currencyBindings = [];
  pool.getConnection = async () => ({
    beginTransaction: async () => {}, commit: async () => { commits++; }, rollback: async () => { rollbacks++; }, release() {},
    execute: async (sql, params) => { calls.push({ sql, params });
      if (sql.includes('FROM xero_connection')) return [[{ xero_tenant_id: TENANT }]];
      if (sql.includes('FROM currency WHERE')) return [[{ id: '30', detail: { HKD: 7.8, USD: 1 } }]];
      if (sql.includes('FROM xero_browser_currency_binding')) return [currencyBindings];
      if (sql.includes('INSERT INTO xero_browser_currency_binding')) currencyBindings.push({ currency_id: params[1], currency_code: params[2] });
      return [[]]; },
  });
  const adminClaims = { permissions: ['*'], isSuperAdmin: true };
  const wrong = await request(adminClaims, { ui_org_slug: 'verified-org', xero_tenant_id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' }, '/binding', 'PUT');
  assert.equal(wrong.status, 409); assert.equal(rollbacks, 1); assert.equal(commits, 0);
  const bound = await request(adminClaims, { ui_org_slug: 'verified-org', xero_tenant_id: TENANT.toUpperCase() }, '/binding', 'PUT');
  assert.equal(bound.status, 200); assert.equal(commits, 1);
  assert.equal(calls.filter(c => /^\s*INSERT INTO xero_browser_binding/.test(c.sql)).length, 1);
  assert.equal((await request(adminClaims, { currency_id: '30', currency_code: 'HKD' }, '/currency', 'PUT')).status, 400);
  assert.equal((await request(adminClaims, { currency_id: '30', currency_code: 'HKD', confirm_invoice_lease_currency: true }, '/currency', 'PUT')).status, 200);
  assert.equal((await request(adminClaims, { currency_id: '30', currency_code: 'USD', confirm_invoice_lease_currency: true }, '/currency', 'PUT')).status, 409);
  assert.equal(calls.filter(c => /^\s*INSERT INTO xero_browser_currency_binding/.test(c.sql)).length, 1);
  assert.ok(calls.every(c => !/^\s*UPDATE currency\b/i.test(c.sql)), 'Legacy rate-table JSON must remain untouched');
  const beforeBurst = resolvedPools;
  let blockedBeforeAuth = false;
  for (let i = 0; i < 121; i++) {
    const burst = await request({ id: String(10000 + i), permissions: ['*'] }, {});
    if (burst.status === 429) {
      const body = await burst.json();
      if (body.message === 'Too many requests. Please wait before retrying.') blockedBeforeAuth = true;
    } else assert.equal(burst.status, 400);
  }
  assert.equal(blockedBeforeAuth, true);
  assert.ok(resolvedPools - beforeBurst < 121, 'IP limiter must stop the burst before auth resolves an org pool');
});

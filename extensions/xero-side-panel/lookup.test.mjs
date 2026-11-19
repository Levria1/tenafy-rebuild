import test from 'node:test';
import assert from 'node:assert/strict';
import { statementDate, lookupRequest, fingerprint, validResult } from './lookup.mjs';
import { staffRequest } from './tenafy.mjs';

const snapshot = { organisation: 'verified-org', account: 'a'.repeat(32) };
const mapping = { xeroOrganisation: snapshot.organisation, xeroAccount: snapshot.account, tenafyOrganisation: '1', currency: 'HKD' };
const row = { suffix: 'b'.repeat(32), current: true, date: '19 Nov 2026', direction: 'Received', currency: 'HKD', minorUnits: 1380000 };
const request = () => lookupRequest(snapshot, mapping, row);
const result = () => ({ version: 1, expires_at: '2026-11-19T10:05:00Z', candidates: [], notices: [],
  capabilities: { read_only: true, live_autofill: false },
  identity: { org_id: '1', ui_org_slug: snapshot.organisation, xero_account_id: snapshot.account, statement: request().statement } });

test('dates accept explicit English month names and ISO, and reject impossible/ambiguous dates', () => {
  for (const raw of ['19 Nov 2026', '19 November 2026', 'Nov 19, 2026', '2026-11-19']) assert.equal(statementDate(raw), '2026-11-19');
  for (const raw of ['11/12/2026', '31 Feb 2026', '19 Novemberoops 2026', '', '2026-13-19']) assert.equal(statementDate(raw), null);
});

test('lookup requires mapped live identity; request sends no unclassified summary or credentials', () => {
  const body = request();
  assert.equal(body.statement.amount_minor, 1380000); assert.equal(body.statement.direction, 'received');
  assert.equal(body.expected_org_id, '1'); assert.equal(body.summary, undefined);
  for (const invalid of [{ ...row, current: false }, { ...row, minorUnits: null }, { ...row, direction: null }, { ...row, currency: 'USD' }]) assert.throws(() => lookupRequest(snapshot, mapping, invalid));
  assert.throws(() => lookupRequest({ ...snapshot, account: 'c'.repeat(32) }, mapping, row));
  assert.throws(() => lookupRequest(snapshot, { ...mapping, tenafyOrganisation: '' }, row));
  assert.notEqual(fingerprint(body), fingerprint({ ...body, statement: { ...body.statement, amount_minor: 1400000 } }));
});

test('results reject expired, wrong-bank/org/row/amount/currency/direction proposals and enabled writes', () => {
  const now = Date.parse('2026-11-19T10:00:00Z');
  assert.equal(validResult(result(), request(), now), true);
  for (const key of ['org_id', 'ui_org_slug', 'xero_account_id']) {
    const data = result(); data.identity[key] = 'wrong'; assert.equal(validResult(data, request(), now), false);
  }
  for (const key of ['id_suffix', 'date', 'amount_minor', 'currency', 'direction']) {
    const data = result(); data.identity.statement[key] = 'wrong'; assert.equal(validResult(data, request(), now), false);
  }
  assert.equal(validResult(result(), request(), Date.parse('2026-11-19T10:06:00Z')), false);
  const writable = result(); writable.capabilities.live_autofill = true;
  assert.equal(validResult(writable, request(), now), false);
});

test('staff bridge only uses allowlisted same-origin endpoints without reading or copying a token', async t => {
  const previous = globalThis.location;
  globalThis.location = { origin: 'https://platform.tenafy.com' };
  t.after(() => { if (previous === undefined) delete globalThis.location; else globalThis.location = previous; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, '/api/integrations/xero/browser/lookup');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(options.body), request());
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: 'sample' }) };
  });
  assert.deepEqual(await staffRequest('lookup', request()), { data: 'sample' });
  assert.ok((await staffRequest('https://untrusted.test/', {})).error); assert.equal(calls, 1);
  globalThis.location.origin = 'https://untrusted.test';
  assert.ok((await staffRequest('lookup', request())).error); assert.equal(calls, 1);
});

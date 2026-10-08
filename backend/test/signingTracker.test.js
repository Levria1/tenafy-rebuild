const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSigningRows } = require('../src/utils/signingTracker');

const FROM = '2026-09-01';
const NOW = new Date('2026-10-01T00:00:00Z');
const lease = (overrides = {}) => ({
  id: '100', lease_no: 'LEA100', start_date: '2026-09-10', end_date: '2027-09-09',
  unit_name: '2A', property_name: 'Harbour House', tenant_name: 'Tenant',
  platform_name: 'Direct', requires_signature: 1, ...overrides,
});
const build = (leases, documents = []) => buildSigningRows({ leases, documents, from: FROM, now: NOW });

test('OTA sources show once as ota (never unsigned) and a missing platform is identified', () => {
  const ota = build([
    lease({ id: '1', requires_signature: 0, platform_name: 'Airbnb' }),
    lease({ id: '2', requires_signature: '0', platform_name: 'Agoda' }),
  ], [{ id: 'd1', lease_id: '1', status: 1, term_start: null, term_end: null, sent_at: '2026-09-12' }]);
  assert.equal(ota.length, 2);
  assert.ok(ota.every(r => r.signed_status === 'ota' && r.kind === 'ota'));
  // An OTA booking that started before tracking began is not listed at all.
  assert.deepEqual(build([lease({ id: '4', requires_signature: 0, start_date: '2026-08-01' })]), []);
  const rows = build([lease({ id: '3', platform_name: null, requires_signature: null })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_missing, true);
});

test('new leases without documents are tracked only from the tracking date', () => {
  const rows = build([lease(), lease({ id: '101', start_date: '2026-08-20' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signed_status, 'unsigned');
  assert.equal(rows[0].kind, 'new_lease');
});

test('a cancelled-only new lease is unsigned', () => {
  const rows = build([lease()], [{ id: '1', lease_id: '100', status: 6 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'new_lease');
});

test('maps live, expired and paper-signed requests', () => {
  const leases = [lease({ id: '1' }), lease({ id: '2' }), lease({ id: '3' })];
  const documents = [
    { id: '11', lease_id: '1', status: 1, term_start: FROM, term_end: '2026-12-01', sent_at: '2026-09-02', expires_at: '2026-10-02T00:00:00Z' },
    { id: '12', lease_id: '2', status: 2, term_start: FROM, term_end: '2026-12-01', sent_at: '2026-09-02', expires_at: '2026-09-30T00:00:00Z' },
    { id: '13', lease_id: '3', status: 3, signature_method: 'paper', term_start: FROM, term_end: '2027-09-09', completed_at: '2026-09-05T10:00:00Z' },
  ];
  const rows = build(leases, documents);
  assert.equal(rows.find(r => r.request_id === '11').signed_status, 'pending');
  assert.equal(rows.find(r => r.request_id === '12').signed_status, 'expired');
  assert.equal(rows.find(r => r.request_id === '13').signed_status, 'signed');
  assert.equal(rows.find(r => r.request_id === '13').signed_method, 'paper');
});

test('LEA2824 includes both period and legacy whole-lease expired requests', () => {
  const l = lease({ id: '2824', lease_no: 'LEA2824', start_date: '2025-06-05', end_date: '2027-01-05' });
  const rows = build([l], [
    { id: '1', lease_id: '2824', status: 1, term_start: '2026-09-05', term_end: '2026-11-05', sent_at: '2026-08-08', expires_at: '2026-08-20' },
    { id: '2', lease_id: '2824', status: 1, term_start: null, term_end: null, sent_at: '2026-09-22', expires_at: '2026-09-25' },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.signed_status === 'expired'));
  const legacy = rows.find(r => r.request_id === '2');
  assert.equal(legacy.period_recorded, false);
  assert.equal(legacy.period_start, '2025-06-05');
  assert.equal(legacy.period_end, '2027-01-05');
});

test('extension gaps create an unsigned row unless an exact attempt represents it', () => {
  const l = lease({ start_date: '2025-09-01', end_date: '2026-12-31' });
  const signed = { id: '1', lease_id: '100', status: 3, term_start: '2025-09-01', term_end: '2026-08-31' };
  let rows = build([l], [signed]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ kind: rows[0].kind, start: rows[0].period_start, end: rows[0].period_end },
    { kind: 'extension', start: '2026-09-01', end: '2026-12-31' });

  rows = build([l], [signed, { id: '2', lease_id: '100', status: 1, term_start: '2026-09-01', term_end: '2026-12-31', sent_at: '2026-09-02', expires_at: '2026-10-10' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signed_status, 'pending');
});

test('sorts newest period first then unit ascending', () => {
  const rows = build([
    lease({ id: '1', start_date: '2026-09-02', unit_name: 'Z' }),
    lease({ id: '2', start_date: '2026-09-12', unit_name: 'B' }),
    lease({ id: '3', start_date: '2026-09-12', unit_name: 'A' }),
  ]);
  assert.deepEqual(rows.map(r => r.lease_id), ['3', '2', '1']);
});

test('route is static-first, org-scoped, and clamps the tracking date', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/leasing.js'), 'utf8');
  assert.ok(source.indexOf("router.get('/signing-tracking'") < source.indexOf("router.get('/:id'"));
  const route = source.slice(source.indexOf("router.get('/signing-tracking'"), source.indexOf("router.get('/:id'"));
  assert.match(route, /p\.org_id = \?/);
  assert.match(route, /2026-09-01/);
  assert.match(route, /requested >= earliest \? requested : earliest/);
});

test('an expired request for the extension period is the row for it — no extra unsigned gap row', () => {
  // A LIVE request already suppresses the gap via computePaperworkState; an EXPIRED one
  // does not, so the de-duplication against existing documents is what prevents two rows.
  const rows = build(
    [lease({ id: '9', start_date: '2025-09-01', end_date: '2026-12-31' })],
    [
      { id: 's1', lease_id: '9', status: 3, signature_method: 'esign', term_start: '2025-09-01', term_end: '2026-08-31', completed_at: '2025-08-20' },
      { id: 'e1', lease_id: '9', status: 1, term_start: '2026-09-01', term_end: '2026-12-31', sent_at: '2026-08-25', expires_at: '2026-09-08T00:00:00Z' },
    ]
  );
  assert.deepEqual(rows.map(r => [r.key, r.signed_status]), [['doc:e1', 'expired']]);
});

test('signing-tracking queries are org-scoped', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/leasing.js'), 'utf8');
  const start = src.indexOf("router.get('/signing-tracking'");
  const body = src.slice(start, src.indexOf('router.', start + 20));
  assert.match(body, /WHERE p\.org_id = \? AND l\.deleted_at IS NULL/);
  assert.match(body, /bp\.org_id = \?/);
  assert.match(body, /FROM signature_request\s+WHERE org_id = \? AND lease_id IN/);
});

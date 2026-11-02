const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { stampLease, pdfSafeText } = require('../src/services/signatureStamper');
const { buildSigningRows } = require('../src/utils/signingTracker');

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function helvetica() {
  const doc = await PDFDocument.create();
  return doc.embedFont(StandardFonts.Helvetica);
}

// ── stamping names the standard fonts cannot encode ─────────────────────────

test('accented letters outside WinAnsi fall back to the bare letter', async () => {
  const font = await helvetica();
  assert.equal(pdfSafeText(font, 'Nguyễn Thị Hương'), 'Nguyen Thi Huong');
  assert.equal(pdfSafeText(font, 'Đặng Văn Lâm'), 'Dang Van Lâm');
  assert.equal(pdfSafeText(font, 'Łukasz'), 'Lukasz');
});

test('WinAnsi text is left untouched, and the rest becomes "?"', async () => {
  const font = await helvetica();
  assert.equal(pdfSafeText(font, 'Zoë Müller • a@b.com — ok'), 'Zoë Müller • a@b.com — ok');
  assert.equal(pdfSafeText(font, '陳大文 Chan'), '??? Chan');
  assert.equal(pdfSafeText(font, null), '');
});

test('THE BUG: a Vietnamese signer name no longer crashes stamping', async () => {
  const blank = await PDFDocument.create();
  blank.addPage();
  const party = {
    id: 'p1', role: 'tenant', sort_order: 1, status: 2,
    signer_name: 'Nguyễn Thị Hương', typed_name: 'Nguyễn Thị Hương',
    signer_email: 'tenant@example.com', signature_png: PNG_1x1,
    signed_at: new Date('2026-10-20T03:00:00Z'), signer_ip: '127.0.0.1', signer_ua: 'test',
  };
  const out = await stampLease({
    unsignedPdf: await blank.save(),
    parties: [party],
    landlordSig: { label: 'Trần Văn Bảo', signature_png: PNG_1x1 },
    request: { id: 'r1', sent_at: new Date('2026-10-19T03:00:00Z') },
  });
  const stamped = await PDFDocument.load(out);
  // original page + appended signatures page + certificate of completion
  assert.equal(stamped.getPageCount(), 3);
});

// ── tracker: a fully signed request that never completed ────────────────────

const FROM = '2026-09-01';
const lease = {
  id: '100', lease_no: 'LEA100', start_date: '2026-09-10', end_date: '2027-09-09',
  tenant_name: 'Tenant', platform_name: 'Direct', requires_signature: 1,
};
const doc = (overrides) => ({
  id: 'd1', lease_id: '100', status: 2, term_start: null, term_end: null,
  sent_at: '2026-09-12', expires_at: null, ...overrides,
});
const rowFor = (d, now = new Date('2026-10-01T00:00:00Z')) =>
  buildSigningRows({ leases: [lease], documents: [d], from: FROM, now })[0];

test('every party signed but not completed is flagged for completion', () => {
  const row = rowFor(doc({ party_count: 2, signed_count: 2 }));
  assert.equal(row.needs_completion, true);
  assert.equal(row.signed_status, 'pending');
});

test('an expired link does not hide a request that only needs completing', () => {
  const row = rowFor(doc({ party_count: 1, signed_count: 1, expires_at: '2026-09-20 00:00:00' }));
  assert.equal(row.needs_completion, true);
  assert.equal(row.signed_status, 'pending');
});

test('partly signed, completed and partyless requests are not flagged', () => {
  assert.equal(rowFor(doc({ party_count: 2, signed_count: 1 })).needs_completion, false);
  assert.equal(rowFor(doc({ status: 3, party_count: 1, signed_count: 1 })).needs_completion, false);
  assert.equal(rowFor(doc({ party_count: 0, signed_count: 0 })).needs_completion, false);
});

// ── routes: the signer is not shown a stamping failure; staff can retry ─────

function fakePool(handlers) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      for (const [pattern, result] of handlers) {
        if (pattern.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      return [[]];
    },
  };
}

function loadRouter(orgPool) {
  const stub = (rel, exports) => {
    const id = require.resolve(rel);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('../src/middleware/auth', {
    authenticate: (req, res, next) => { req.user = { orgId: 'org1', userId: 'u1' }; req.pool = orgPool; next(); },
  });
  stub('../src/config/poolRegistry', {
    getMasterPool: () => ({ execute: async () => [[{ id: 'org1', db_name: 'org1' }]] }),
    getOrgPool: async () => orgPool,
    getOrgPoolByDbName: async () => orgPool,
    getReadOnlyOrgPool: async () => orgPool,
    closePools: async () => {},
  });
  delete require.cache[require.resolve('../src/routes/signature')];
  return require('../src/routes/signature');
}

async function call(router, url) {
  const app = express();
  app.use(express.json());
  app.use('/api/signature', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_png: PNG_1x1, typed_name: 'Nguyễn Thị Hương' }),
    });
    return { status: response.status, data: await response.json() };
  } finally { server.close(); }
}

// The original PDF is missing, so finalisation throws after the signature is saved.
const finalizeFails = [
  [/SELECT \* FROM signature_request WHERE id/, [[{ id: 'r1', lease_id: 'L1', original_file_id: 'f1' }]]],
  [/SELECT \* FROM signature_party WHERE request_id/, [[{ id: 'p1', status: 2 }]]],
  [/FROM file WHERE id/, [[]]],
];
const completed = pool => pool.calls.some(c => /UPDATE signature_request SET status = 3/.test(c.sql));

test('the signer gets success when stamping fails after their signature is saved', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pool = fakePool([
    [/JOIN signature_request sr ON sp.request_id/, [[{ id: 'p1', status: 1, request_id: 'r1', request_status: 2 }]]],
    [/COUNT\(\*\) AS total/, [[{ total: 1, signed_count: 1 }]]],
    ...finalizeFails,
  ]);
  const result = await call(loadRouter(pool), '/api/signature/public/tok/sign');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.data, { signed: true });
  assert.ok(pool.calls.some(c => /UPDATE signature_party/.test(c.sql)), 'signature saved');
  assert.equal(completed(pool), false);
});

test('finalize refuses a request that is already completed', async () => {
  const pool = fakePool([[/FROM signature_request WHERE id = \? AND org_id = \?/, [[{ id: 'r1', lease_id: 'L1', status: 3 }]]]]);
  const result = await call(loadRouter(pool), '/api/signature/request/r1/finalize');
  assert.equal(result.status, 400);
  assert.deepEqual(pool.calls[0].params, ['r1', 'org1']);
});

test('finalize refuses while a party has not signed', async () => {
  const pool = fakePool([
    [/FROM signature_request WHERE id = \? AND org_id = \?/, [[{ id: 'r1', lease_id: 'L1', status: 2 }]]],
    [/COUNT\(\*\) AS total/, [[{ total: 2, signed_count: 1 }]]],
  ]);
  const result = await call(loadRouter(pool), '/api/signature/request/r1/finalize');
  assert.equal(result.status, 400);
  assert.match(result.data.message, /not every party has signed/i);
  assert.equal(completed(pool), false);
});

test('finalize reports a stamping failure to staff without completing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pool = fakePool([
    [/FROM signature_request WHERE id = \? AND org_id = \?/, [[{ id: 'r1', lease_id: 'L1', status: 2 }]]],
    [/COUNT\(\*\) AS total/, [[{ total: 1, signed_count: 1 }]]],
    ...finalizeFails,
  ]);
  const result = await call(loadRouter(pool), '/api/signature/request/r1/finalize');
  assert.equal(result.status, 500);
  assert.equal(completed(pool), false);
});

test('finalize is not found for another org\'s request', async () => {
  const pool = fakePool([]);
  const result = await call(loadRouter(pool), '/api/signature/request/r9/finalize');
  assert.equal(result.status, 404);
});

/**
 * A tenant portal receipt must not name other people.
 *
 * Tane receives Airbnb payouts through Xero: one bank deposit covering several
 * guests' stays, split into one accounting_line per guest invoice, with the
 * payment's own tenant_id left NULL. Four landed between 20 Jul and 4 Sep 2026 —
 * TANE41799, TANE41918, TANE42218, TANE42354 — covering nine tenants between them,
 * and seven invoices have no other payment row at all.
 *
 * So an ownership check on `accounting.tenant_id` is not enough twice over: it
 * refuses receipts nine tenants are entitled to (their id is not on the row), and
 * a check that admitted them would hand over a document listing the other guests'
 * invoice codes and amounts. Worse, the payment note on those rows is a transcript
 * of every stay on the deposit — names, confirmation codes, nightly rates and
 * Airbnb's service fee — and the receipt printed it as the description.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  buildVisibleLines, loadReceiptPdfData, renderReceiptPdf,
} = require('../src/routes/pdf');

// Line comments FIRST — a "/*" inside one otherwise opens a phantom block comment
// and swallows the rest of the file, making every doesNotMatch pass vacuously.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const ORG = '8300127259922432';
const MINE = '1785147092626394199';        // Cristian Sánchez Olavarría
const THEIRS = '21502186836004864';        // Hollie Force
const ALSO_THEIRS = '1785131289480134832'; // Ferenc Patrik Nyiri

// TANE41918: HK$31,399.56 across three guests.
const PAYOUT_NOTE =
  'Airbnb Multiple payments — \nTRIV31110 Hollie Force\nMong Kok Luxury Studio *3B\n'
  + 'Confirmation\nHMSCHYJF5P\nTotal (HKD)\n$9,979.63 HKD | \nTRIV34907 Cristian Sanchez\n'
  + 'Fuk Lo Tsun Road Private Room, New Reno *2I\nConfirmation\nHM83NARC9H\n'
  + '$337.64 x 28 nights\nCleaning fee\n$459.00 HKD\nService fee\n-$1,536.50 HKD';

const payoutLines = () => [
  { amount: '9979.63', invoice_code: 'TRIV31110', invoice_tenant_id: THEIRS, invoice_note: 'Rent April', property_currency: 'HKD' },
  { amount: '8376.42', invoice_code: 'TRIV34907', invoice_tenant_id: MINE, invoice_note: 'Rent August', property_currency: 'HKD' },
  { amount: '13043.51', invoice_code: 'TRIV34902', invoice_tenant_id: ALSO_THEIRS, invoice_note: 'Rent August', property_currency: 'HKD' },
];

// ── the rule itself ─────────────────────────────────────────────────────────

test('staff receipts are unchanged — every line, whatever the tenants', () => {
  const lines = payoutLines();
  assert.deepStrictEqual(buildVisibleLines({ tenant_id: null }, lines, null), lines);
});

test('a combined payout is cut down to the asking tenant\'s own line', () => {
  const visible = buildVisibleLines({ tenant_id: null }, payoutLines(), [MINE]);
  assert.strictEqual(visible.length, 1);
  assert.strictEqual(visible[0].invoice_code, 'TRIV34907');
});

test('an ordinary payment booked to the tenant keeps all of its lines', () => {
  // Rent plus a utility excess plus a penalty, all theirs. 132 payments look like
  // this and must not lose lines to the scoping rule.
  const lines = [
    { amount: '20000.00', invoice_code: 'TRIV35049', invoice_tenant_id: MINE },
    { amount: '412.00', invoice_code: 'TRIV35267', invoice_tenant_id: MINE },
  ];
  const visible = buildVisibleLines({ tenant_id: MINE }, lines, [MINE]);
  assert.strictEqual(visible.length, 2);
});

test('orphan lines ride along on an unambiguous payment', () => {
  // 14,787 lines carry a Xero reference matching no surviving invoice. They have no
  // tenant to check, so they travel only on a payment that is plainly this tenant's.
  const lines = [
    { amount: '100.00', invoice_code: 'XERO-88', invoice_tenant_id: null },
    { amount: '200.00', invoice_code: 'TRIV35049', invoice_tenant_id: MINE },
  ];
  const visible = buildVisibleLines({ tenant_id: MINE }, lines, [MINE]);
  assert.strictEqual(visible.length, 2);
});

test('orphan lines are dropped once another tenant is on the payment', () => {
  const lines = [
    { amount: '100.00', invoice_code: 'XERO-88', invoice_tenant_id: null },
    { amount: '200.00', invoice_code: 'TRIV34907', invoice_tenant_id: MINE },
    { amount: '300.00', invoice_code: 'TRIV31110', invoice_tenant_id: THEIRS },
  ];
  const visible = buildVisibleLines({ tenant_id: MINE }, lines, [MINE]);
  assert.deepStrictEqual(visible.map(l => l.invoice_code), ['TRIV34907']);
});

test('a stranger gets nothing', () => {
  const visible = buildVisibleLines({ tenant_id: null }, payoutLines(), ['9999999999']);
  assert.strictEqual(visible.length, 0);
});

test('an additional tenant on the lease is scoped in alongside the named one', () => {
  const visible = buildVisibleLines({ tenant_id: null }, payoutLines(), [MINE, ALSO_THEIRS]);
  assert.deepStrictEqual(visible.map(l => l.invoice_code), ['TRIV34907', 'TRIV34902']);
});

// ── the loader ──────────────────────────────────────────────────────────────

function fakePool({ payment, lines }) {
  return {
    execute: async (sql, params = []) => {
      if (/FROM accounting a/i.test(sql) && /payment_method_setting/i.test(sql)) {
        const [id, org] = params.map(String);
        if (org !== ORG || String(payment.id) !== id) return [[]];
        return [[payment]];
      }
      if (/FROM accounting_line al/i.test(sql)) return [lines];
      if (/FROM organization/i.test(sql)) return [[{ company_name: 'Tane', default_currency: 'HKD' }]];
      return [[]];
    },
  };
}

const PAYOUT = {
  id: '1785832467936535846',
  tenant_id: null,
  transaction_code: 'TANE41918',
  payment_date: '2026-08-03',
  header_amount: '31399.56',
  payment_note: PAYOUT_NOTE,
};

test('a scoped receipt totals the tenant\'s own line, not the whole deposit', async () => {
  const pool = fakePool({ payment: PAYOUT, lines: payoutLines() });
  const data = await loadReceiptPdfData(pool, PAYOUT.id, ORG, { tenantIds: [MINE] });
  assert.ok(data, 'the tenant is entitled to a receipt');
  assert.strictEqual(data.paymentAmount, 8376.42);
  assert.notStrictEqual(data.paymentAmount, 31399.56);
});

test('a scoped receipt never carries the raw payment note', async () => {
  const pool = fakePool({ payment: PAYOUT, lines: payoutLines() });
  const data = await loadReceiptPdfData(pool, PAYOUT.id, ORG, { tenantIds: [MINE] });
  assert.strictEqual(data.allowPaymentNote, false);
});

test('the staff receipt still carries it', async () => {
  const pool = fakePool({ payment: PAYOUT, lines: payoutLines() });
  const data = await loadReceiptPdfData(pool, PAYOUT.id, ORG);
  assert.strictEqual(data.allowPaymentNote, true);
  // Summed as floats, so this is 31399.559999999998. The renderer's formatter rounds
  // it to 31,399.56 on the page, which is what the reader sees and what matters.
  assert.strictEqual(Number(data.paymentAmount.toFixed(2)), 31399.56);
});

test('a payment with nothing of theirs on it is not found', async () => {
  const pool = fakePool({ payment: PAYOUT, lines: payoutLines() });
  const data = await loadReceiptPdfData(pool, PAYOUT.id, ORG, { tenantIds: ['9999999999'] });
  assert.strictEqual(data, null);
});

test('a payment with no lines is receipted only for whoever it is booked against', async () => {
  const bare = { ...PAYOUT, tenant_id: MINE, payment_note: 'Bank transfer', invoice_code: 'TRIV35049' };
  const mine = await loadReceiptPdfData(fakePool({ payment: bare, lines: [] }), bare.id, ORG, { tenantIds: [MINE] });
  assert.ok(mine, 'their own line-less payment is receiptable');
  // With no lines there is nothing to sum, so the header amount is the honest total.
  assert.strictEqual(mine.paymentAmount, 31399.56);

  const stranger = await loadReceiptPdfData(fakePool({ payment: bare, lines: [] }), bare.id, ORG, { tenantIds: [THEIRS] });
  assert.strictEqual(stranger, null);
});

test('the property block comes from the tenant\'s own line', async () => {
  const lines = payoutLines();
  lines[0].property_name = 'Mong Kok Luxury Studio';
  lines[0].unit_name = '3B';
  lines[1].property_name = 'Fuk Lo Tsun Road';
  lines[1].unit_name = '2I';
  const data = await loadReceiptPdfData(fakePool({ payment: PAYOUT, lines }), PAYOUT.id, ORG, { tenantIds: [MINE] });
  assert.strictEqual(data.firstLine.property_name, 'Fuk Lo Tsun Road');
});

// ── what actually lands on the page ─────────────────────────────────────────

// Collects every string the renderer draws, so the assertion is against the
// document rather than a restatement of the logic that built it.
function stubDoc() {
  const drawn = [];
  const doc = {
    page: { width: 595, height: 842 },
    text: (t) => { drawn.push(String(t)); return doc; },
    rect: () => doc, fill: () => doc, fillColor: () => doc, font: () => doc,
    fontSize: () => doc, moveTo: () => doc, lineTo: () => doc, stroke: () => doc,
    strokeColor: () => doc, lineWidth: () => doc, image: () => doc,
    heightOfString: () => 10,
  };
  doc.drawn = drawn;
  return doc;
}

test('the other guests are nowhere on a scoped receipt', async () => {
  const pool = fakePool({ payment: PAYOUT, lines: payoutLines() });
  const data = await loadReceiptPdfData(pool, PAYOUT.id, ORG, { tenantIds: [MINE] });
  const doc = stubDoc();
  renderReceiptPdf(doc, data);
  const page = doc.drawn.join('\n');

  assert.match(page, /TRIV34907/, 'their own invoice is on it');
  assert.doesNotMatch(page, /TRIV31110/, 'another guest\'s invoice code leaked');
  assert.doesNotMatch(page, /TRIV34902/, 'another guest\'s invoice code leaked');
  assert.doesNotMatch(page, /Hollie Force/, 'another guest\'s name leaked');
  assert.doesNotMatch(page, /HMSCHYJF5P/, 'another guest\'s confirmation code leaked');
  assert.doesNotMatch(page, /Service fee/, 'Airbnb\'s fee to the landlord leaked');
  assert.doesNotMatch(page, /Multiple payments/, 'the combined payout note leaked');
  assert.doesNotMatch(page, /31,399\.56/, 'the whole deposit total leaked');
  assert.match(page, /8,376\.42/, 'their own amount is shown');
});

test('the staff receipt is left alone', async () => {
  const pool = fakePool({ payment: PAYOUT, lines: payoutLines() });
  const data = await loadReceiptPdfData(pool, PAYOUT.id, ORG);
  const doc = stubDoc();
  renderReceiptPdf(doc, data);
  const page = doc.drawn.join('\n');
  assert.match(page, /TRIV31110/);
  assert.match(page, /TRIV34907/);
  assert.match(page, /31,399\.56/);
});

test('a single-line staff receipt keeps its payment-note description', async () => {
  const payment = { ...PAYOUT, tenant_id: MINE, payment_note: 'Rental payment for Sept. 5 - Oct. 4, 2026' };
  const lines = [{ amount: '20000.00', invoice_code: 'TRIV35049', invoice_tenant_id: MINE, invoice_note: 'Rent', property_currency: 'HKD' }];
  const data = await loadReceiptPdfData(fakePool({ payment, lines }), payment.id, ORG);
  const doc = stubDoc();
  renderReceiptPdf(doc, data);
  assert.match(doc.drawn.join('\n'), /Rental payment for Sept\. 5 - Oct\. 4, 2026/);
});

test('the same receipt on the portal falls back to the invoice note instead', async () => {
  const payment = { ...PAYOUT, tenant_id: MINE, payment_note: 'Rental payment for Sept. 5 - Oct. 4, 2026' };
  const lines = [{ amount: '20000.00', invoice_code: 'TRIV35049', invoice_tenant_id: MINE, invoice_note: 'Rent, September', property_currency: 'HKD' }];
  const data = await loadReceiptPdfData(fakePool({ payment, lines }), payment.id, ORG, { tenantIds: [MINE] });
  const doc = stubDoc();
  renderReceiptPdf(doc, data);
  const page = doc.drawn.join('\n');
  assert.match(page, /Rent, September/);
  assert.doesNotMatch(page, /Rental payment for Sept/);
});

// ── the routes ──────────────────────────────────────────────────────────────

const portal = stripComments(read('../src/routes/tenantPortal.js'));

test('the receipt PDF is not a second copy of the renderer', () => {
  const pdf = read('../src/routes/pdf.js');
  // Both the route and the email path used to draw the receipt themselves, and had
  // already drifted: 16 currency symbols against 8, and the rule under the totals
  // block 10pt out. One renderer, called twice.
  assert.strictEqual((pdf.match(/RECEIVED FROM/g) || []).length, 1);
  assert.strictEqual((pdf.match(/function renderReceiptPdf/g) || []).length, 1);
});

test('every new portal route is gated by the tenant middleware, never the staff one', () => {
  const routes = portal.match(/router\.(get|post|put|delete)\('([^']+)'[^)]*/g) || [];
  const added = routes.filter(r => /'\/(utilities|invoices\/:id\/pdf|invoices\/:id\/payments|payments\/:id\/receipt)'/.test(r));
  assert.strictEqual(added.length, 4, 'expected all four new routes');
  added.forEach((r) => {
    assert.match(r, /authenticateTenant/, `${r} is missing authenticateTenant`);
    assert.doesNotMatch(r, /[^t]\bauthenticate\b\s*,/, `${r} routes a tenant through staff auth`);
  });
});

test('the invoice PDF checks ownership before rendering', () => {
  // `deleted_at IS NULL` matters: a voided invoice must stop producing a document.
  assert.match(portal, /FROM invoice\s+WHERE id = \? AND tenant_id IN \(\$\{idsIn\(req\)\}\) AND org_id = \? AND deleted_at IS NULL/);
});

test('utility queries are scoped by org through the parent tables', () => {
  // utility_bill_line has no org_id of its own, so the join IS the boundary. Without
  // it, a bill line id from another org's database would read straight through.
  const utilities = portal.slice(portal.indexOf("router.get('/utilities'"));
  assert.match(utilities, /JOIN utility_bill b ON bl\.bill_id = b\.id/);
  assert.match(utilities, /WHERE bl\.tenant_id IN \(\$\{ph\}\) AND b\.org_id = \?/);
  assert.match(utilities, /WHERE cs\.tenant_id IN \(\$\{ph\}\) AND cs\.org_id = \?/);
});

test('the utility history count is read as a number', () => {
  // bigNumberStrings is on for both pools, so COUNT(*) arrives as a STRING and '0'
  // is truthy. Every tenant would have got a Utilities tab.
  const probe = portal.slice(portal.indexOf('async function hasUtilityHistory'));
  assert.match(probe, /Number\(n\) > 0/);
  assert.match(probe, /Number\(settled\.n\) > 0/);
});

test('a missing settlement table does not take the page down', () => {
  // utility_checkout_settlement postdates some org databases — the staff endpoint
  // guards it the same way.
  const utilities = portal.slice(portal.indexOf("router.get('/utilities'"));
  assert.match(utilities, /utility_checkout_settlement[\s\S]*?\}\s*catch/);
});

test('the utilities tab is a lease-wide view, so an additional tenant sees it too', () => {
  const utilities = portal.slice(portal.indexOf("router.get('/utilities'"));
  assert.match(utilities, /leaseIsTheirs\(ph\)/);
});

test('the portal never reaches the staff PDF routes, only the renderers', () => {
  assert.match(portal, /require\('\.\/pdf'\)/);
  assert.doesNotMatch(portal, /\/api\/pdf\//);
});

// ── the pages ───────────────────────────────────────────────────────────────

test('the invoices table reads the fields the API actually sends', () => {
  // It asked for `description` and `due_on` was called `due_date`, so both columns
  // rendered '-' and 'N/A' for every invoice since the portal went live.
  const page = stripComments(read('../../frontend/src/app/tenant-portal/invoices/page.js'));
  assert.match(page, /dataIndex: 'note'/);
  assert.match(page, /dataIndex: 'due_on'/);
  assert.doesNotMatch(page, /dataIndex: 'description'/);
  assert.doesNotMatch(page, /dataIndex: 'due_date'/);
});

test('a payment with no receipt shows why rather than a dead button', () => {
  const page = stripComments(read('../../frontend/src/app/tenant-portal/invoices/page.js'));
  assert.match(page, /receipt_available/);
  assert.match(page, /Receipt on request/);
});

test('the Utilities tab is hidden for tenants who have no utility history', () => {
  const layout = stripComments(read('../../frontend/src/app/tenant-portal/layout.js'));
  assert.match(layout, /feature: 'utilities'/);
  assert.match(layout, /navItems\.filter\(\(item\) => !item\.feature \|\| features\[item\.feature\]\)/);
  // Selection must run over the visible list, or a hidden tab could be highlighted.
  assert.match(layout, /visibleNav\.find/);
});

test('the utilities page offers no way to edit a reading', () => {
  // The staff tab has edit and undo on a settlement. This is a statement, not a form.
  const page = stripComments(read('../../frontend/src/app/tenant-portal/utilities/page.js'));
  ['Popconfirm', 'updateSettlement', 'deleteSettlement', 'onFinish', '<Form'].forEach((token) => {
    assert.ok(!page.includes(token), `utilities page should not contain ${token}`);
  });
});

test('receipt availability is answered in one query, not one per payment', () => {
  // One invoice in Tane's data carries 18 payments. Loading each receipt to decide
  // whether to show its button was 54 queries for one row expanding.
  const payments = portal.slice(portal.indexOf("router.get('/invoices/:id/payments'"));
  const body = payments.slice(0, payments.indexOf('router.get(', 10));
  assert.match(body, /AS own_lines/);
  assert.match(body, /Number\(own_lines\) > 0/);
  assert.doesNotMatch(body, /for \(const p of payments\)/,
    'availability must not be resolved by looping loadReceiptPdfData');
  assert.doesNotMatch(body, /loadReceiptPdfData/);
});

test('the availability subquery is scoped to the asking tenant', () => {
  const payments = portal.slice(portal.indexOf("router.get('/invoices/:id/payments'"));
  const body = payments.slice(0, payments.indexOf('router.get(', 10));
  assert.match(body, /AND i2\.tenant_id IN \(\$\{ph\}\)/);
  assert.match(body, /i2\.org_id = a\.org_id/);
  assert.match(body, /\[\.\.\.tenantIds, inv\.invoice_code, orgId\]/,
    'the tenant placeholders come first in the SQL, so they must come first in the params');
});

test('the download filename cannot inject a response header', () => {
  // It is built from an invoice or transaction code and lands in Content-Disposition.
  const send = portal.slice(portal.indexOf('function sendPdf'));
  assert.match(send, /replace\(\/\[\^A-Za-z0-9\._-\]\/g, '_'\)/);
  assert.match(send, /slice\(0, 100\)/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// "Split invoicing is not available in Reconcile (Xero)": a deposit Tenafy
// auto-matched to ONE invoice (match_kind invoice_payment, the green "Pay
// invoice" tag) had no Split link, so a payment covering two invoices could only
// be booked against the first. The server already took `lines` for these rows;
// these tests pin that, and that the page now offers the split on them.

const ORG = 'org1';
const ROW = {
  id: 'p1', org_id: ORG, status: 'pending', match_kind: 'invoice_payment',
  amount: '15000.00', description: 'FPS TRIV100 TRIV101', transaction_date: '2026-11-01',
  xero_transaction_id: 'x1', xero_account_id: 'xa1',
  proposed_account_id: 'acc1', proposed_category_id: 'rent', proposed_invoice_id: 'inv100',
  proposed_tenant_id: 't1', existing_accounting_id: null, ambiguous_candidates: null,
};
const INVOICES = {
  inv100: { invoice_code: 'TRIV100', amount: '11000.00', property_id: 'p', unit_id: 'u', leasing_id: 'l', tenant_id: 't1' },
  inv101: { invoice_code: 'TRIV101', amount: '4000.00', property_id: 'p', unit_id: 'u', leasing_id: 'l', tenant_id: 't1' },
};

function fakePool() {
  const calls = [];
  const conn = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM xero_pending_reconciliation WHERE id = \? AND org_id = \? AND status = 'pending'/.test(sql)) return [[ROW]];
      if (/FROM currency/.test(sql)) return [[{ id: 'hkd', detail: '{"code":"HKD"}' }]];
      if (/FROM invoice WHERE id = \?/.test(sql)) return [[INVOICES[params[0]]].filter(Boolean)];
      if (/SUM\(al.amount\),0\) AS paid/.test(sql)) return [[{ paid: 0 }]];
      return [{ affectedRows: 1 }];
    },
  };
  return { calls, async getConnection() { return conn; }, execute: conn.execute };
}

function loadRouter(pool) {
  const stub = (rel, exports) => {
    const id = require.resolve(rel);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('../src/middleware/auth', {
    authenticate: (req, res, next) => { req.user = { orgId: ORG, id: 'u1' }; req.pool = pool; next(); },
    requirePermission: () => (req, res, next) => next(),
  });
  stub('../src/utils/sequenceCode', { generateSequenceCode: async () => 'TX1' });
  stub('../src/utils/invoiceStatus', { recalcInvoiceStatuses: async () => {} });
  delete require.cache[require.resolve('../src/routes/xero')];
  return require('../src/routes/xero');
}

async function approve(body) {
  const pool = fakePool();
  const app = express();
  app.use(express.json());
  app.use('/x', loadRouter(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/x/pending/p1/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const lines = pool.calls.filter(c => /INSERT INTO accounting_line/.test(c.sql)).map(c => [c.params[2], c.params[4]]);
    const header = pool.calls.find(c => /INSERT INTO accounting\s/.test(c.sql));
    return { status: r.status, data: await r.json(), lines, header };
  } finally { server.close(); }
}

test('a Pay invoice row split across two invoices books one line per invoice', async () => {
  const r = await approve({
    account_id: 'acc1', invoice_id: 'inv100', direction: 'inflow',
    lines: [{ amount: 11000, category_id: 'rent', invoice_id: 'inv100' }, { amount: 4000, category_id: 'elec', invoice_id: 'inv101' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.lines, [['11000', 'TRIV100'], ['4000', 'TRIV101']].map(([a, c]) => [Number(a), c]));
  // Header invoice_code is null when the lines pay different invoices.
  assert.equal(r.header.params[14], null);
});

test('without a split it still pays the matched invoice in full', async () => {
  const r = await approve({ account_id: 'acc1', invoice_id: 'inv100', direction: 'inflow' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.lines, [[15000, 'TRIV100']]);
});

test('a split that does not add up to the deposit is refused', async () => {
  const r = await approve({
    account_id: 'acc1', invoice_id: 'inv100', direction: 'inflow',
    lines: [{ amount: 11000, category_id: 'rent', invoice_id: 'inv100' }, { amount: 3000, category_id: 'elec', invoice_id: 'inv101' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /must sum to the transaction total/);
  assert.deepEqual(r.lines, []);
});

test('a line above its invoice\'s outstanding balance is refused', async () => {
  const r = await approve({
    account_id: 'acc1', invoice_id: 'inv100', direction: 'inflow',
    lines: [{ amount: 12000, category_id: 'rent', invoice_id: 'inv100' }, { amount: 3000, category_id: 'elec', invoice_id: 'inv101' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /exceeds its outstanding balance/);
});

test('the Reconcile page offers the split on Pay invoice rows', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/src/app/accounting/reconcile/page.js'), 'utf8');
  const start = src.indexOf("if (row.match_kind === 'invoice_payment')");
  const end = src.indexOf("if (row.match_kind === 'ambiguous')", start);
  assert.ok(start > 0 && end > start);
  assert.match(src.slice(start, end), /renderCategoryOrSplit\(row\)/);
});

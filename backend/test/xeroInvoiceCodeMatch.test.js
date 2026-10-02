const test = require('node:test');
const assert = require('node:assert/strict');
const { findInvoiceByCode, stageTransaction } = require('../src/services/xeroSync');

function poolWithRows(rows, inspect = null) {
  return {
    execute: async (sql, params) => {
      if (inspect) inspect(sql, params);
      return [rows];
    },
  };
}

test('invoice code part payment matches with full=false', async () => {
  const match = await findInvoiceByCode(poolWithRows([{
    id: 9007199254740993n,
    tenant_id: 9007199254740995n,
    leasing_id: 9007199254740997n,
    invoice_code: 'TRIV35232',
    outstanding: '12000.00',
  }]), 'org-1', { amount: 6000, description: 'TRIV35232 Rental payment' });

  assert.deepEqual(match, {
    invoice_id: '9007199254740993',
    tenant_id: '9007199254740995',
    leasing_id: '9007199254740997',
    invoice_code: 'TRIV35232',
    outstanding: 12000,
    full: false,
  });
});

test('bank amount equal to outstanding matches with full=true', async () => {
  const match = await findInvoiceByCode(poolWithRows([{
    id: '11', tenant_id: '12', leasing_id: null,
    invoice_code: 'INV760', outstanding: '5000.00',
  }]), 'org-1', { amount: 5000, description: 'Payment INV760' });

  assert.equal(match.full, true);
  assert.equal(match.outstanding, 5000);
});

test('amount exceeding outstanding does not match', async () => {
  const match = await findInvoiceByCode(poolWithRows([{
    id: '11', tenant_id: '12', leasing_id: null,
    invoice_code: 'INV760', outstanding: '4999.98',
  }]), 'org-1', { amount: 5000, description: 'Payment INV760' });

  assert.equal(match, null);
});

test('description without an invoice code returns null without querying', async () => {
  let queried = false;
  const match = await findInvoiceByCode(poolWithRows([], () => { queried = true; }), 'org-1', {
    amount: 6000,
    description: 'Rental payment for October',
  });

  assert.equal(match, null);
  assert.equal(queried, false);
});

test('two different named open invoices are ambiguous', async () => {
  const match = await findInvoiceByCode(poolWithRows([
    { id: '1', invoice_code: 'TRIV35232', outstanding: 12000 },
    { id: '2', invoice_code: 'TANEINV123', outstanding: 9000 },
  ]), 'org-1', {
    amount: 6000,
    description: 'TRIV35232 and TANEINV123',
  });

  assert.equal(match, null);
});

test('query excludes paid and deleted invoices and is org scoped', async () => {
  await findInvoiceByCode(poolWithRows([], (sql, params) => {
    assert.match(sql, /inv\.status\s*!=\s*1/i);
    assert.match(sql, /inv\.deleted_at\s+IS\s+NULL/i);
    assert.match(sql, /inv\.org_id\s*=\s*\?/i);
    assert.match(sql, /a\.org_id\s*=\s*inv\.org_id/i);
    assert.match(sql, /a\.deleted_at\s+IS\s+NULL/i);
    assert.match(sql, /al\.deleted_at\s+IS\s+NULL/i);
    assert.deepEqual(params, ['org-77', 'TRIV35232']);
  }), 'org-77', { amount: 6000, description: 'triv35232' });
});

test('lowercase invoice code is recognised and normalised', async () => {
  let queryParams;
  const match = await findInvoiceByCode(poolWithRows([{
    id: '21', tenant_id: null, leasing_id: null,
    invoice_code: 'TRIV35232', outstanding: 12000,
  }], (_sql, params) => { queryParams = params; }), 'org-1', {
    amount: 6000,
    description: 'triv35232 Rental payment',
  });

  assert.deepEqual(queryParams, ['org-1', 'TRIV35232']);
  assert.equal(match.invoice_code, 'TRIV35232');
});

test('second instalment matches the remaining balance as a full payment', async () => {
  // The SQL-calculated outstanding represents invoice 12,000 less 6,000 paid.
  const match = await findInvoiceByCode(poolWithRows([{
    id: '31', tenant_id: '32', leasing_id: '33',
    invoice_code: 'TRIV35232', outstanding: '6000.00',
  }]), 'org-1', {
    amount: 6000,
    description: 'TRIV35232 Rental payment for Oct. 1 - 31, 2026',
  });

  assert.equal(match.full, true);
  assert.equal(match.outstanding, 6000);
});

test('duplicate references to the same code produce one query candidate', async () => {
  await findInvoiceByCode(poolWithRows([], (_sql, params) => {
    assert.deepEqual(params, ['org-1', 'TRIV35232']);
  }), 'org-1', {
    amount: 6000,
    description: 'triv35232 / TRIV35232',
  });
});

test('TANEINV codes are recognised and not misread as INV', async () => {
  let params;
  await findInvoiceByCode(poolWithRows([], (_sql, p) => { params = p; }), 'org-1',
    { amount: 500, description: 'Payment TANEINV00123 thanks' });
  assert.deepEqual(params, ['org-1', 'TANEINV00123']);
});

// ---------------------------------------------------------------------------
// Wiring: stageTransaction must consult the code matcher before the old
// exact-amount-and-name matcher, and grade a part payment as medium.
// ---------------------------------------------------------------------------
function stagingPool({ codeRows = [], amountRows = [] } = {}) {
  const staged = {};
  const pool = {
    execute: async (sql, params) => {
      if (/INSERT INTO xero_pending_reconciliation/.test(sql)) {
        staged.match_kind = params[11];
        staged.proposed_invoice_id = params[14];
        staged.proposed_tenant_id = params[15];
        staged.confidence = params[18];
        return [{}];
      }
      if (/invoice_code IN/.test(sql)) return [codeRows];
      if (/FROM invoice i\b/.test(sql)) return [amountRows];
      if (/SELECT id FROM accounting/.test(sql)) return [[undefined]];
      return [[]]; // dedup candidates, category_setting, xero_category_rule: none
    },
  };
  return { pool, staged };
}

const RECEIVE = (reference, total = 6000) => ({
  BankTransactionID: 'X-1', Type: 'RECEIVE', Total: total, Date: '2026-09-28T00:00:00',
  BankAccount: { AccountID: 'xa-1' }, Contact: { Name: 'Yanru Jiang "Casey"' },
  Reference: reference, LineItems: [{ Description: reference }],
});

test('a part payment naming its invoice is staged as invoice_payment at medium confidence', async () => {
  const { pool, staged } = stagingPool({
    codeRows: [{ id: '111', tenant_id: '222', leasing_id: '333', invoice_code: 'TRIV35232', outstanding: '12000.00' }],
  });
  await stageTransaction(pool, 'org-1', RECEIVE('TRIV35232 Rental payment for Oct. 1 - 31, 2026'), { 'xa-1': 'acct-1' });
  assert.equal(staged.match_kind, 'invoice_payment');
  assert.equal(staged.proposed_invoice_id, '111');
  assert.equal(staged.proposed_tenant_id, '222');
  assert.equal(staged.confidence, 'medium');
});

test('a payment clearing the balance of the named invoice is high confidence', async () => {
  const { pool, staged } = stagingPool({
    codeRows: [{ id: '111', tenant_id: '222', leasing_id: '333', invoice_code: 'TRIV35232', outstanding: '6000.00' }],
  });
  await stageTransaction(pool, 'org-1', RECEIVE('TRIV35232 Rental payment'), { 'xa-1': 'acct-1' });
  assert.equal(staged.match_kind, 'invoice_payment');
  assert.equal(staged.confidence, 'high');
});

test('with no invoice code the old exact-amount and name matcher still applies', async () => {
  const { pool, staged } = stagingPool({
    amountRows: [{ id: '444', amount: 6000, tenant_id: '555', leasing_id: null, due_on: '2026-10-01',
      first_name: 'Yanru', last_name: 'Jiang', company_name: null, tenant_type: 0 }],
  });
  await stageTransaction(pool, 'org-1', RECEIVE('October rent'), { 'xa-1': 'acct-1' });
  assert.equal(staged.match_kind, 'invoice_payment');
  assert.equal(staged.proposed_invoice_id, '444');
  assert.equal(staged.confidence, 'high');
});

test('no code and no amount match falls back to a new entry', async () => {
  const { pool, staged } = stagingPool();
  await stageTransaction(pool, 'org-1', RECEIVE('October rent'), { 'xa-1': 'acct-1' });
  assert.equal(staged.match_kind, 'new_entry');
});

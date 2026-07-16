const test = require('node:test');
const assert = require('node:assert');
const { resolveHeaderInvoiceCode, validateSplitTotal } = require('../src/utils/reconcileSplit');

test('resolveHeaderInvoiceCode: all lines same code -> that code', () => {
  assert.strictEqual(
    resolveHeaderInvoiceCode([{ invoice_code: 'TRIV1' }, { invoice_code: 'TRIV1' }]),
    'TRIV1'
  );
});

test('resolveHeaderInvoiceCode: mixed codes -> null', () => {
  assert.strictEqual(
    resolveHeaderInvoiceCode([{ invoice_code: 'TRIV1' }, { invoice_code: 'TRIV2' }]),
    null
  );
});

test('resolveHeaderInvoiceCode: any uninvoiced line -> null', () => {
  assert.strictEqual(
    resolveHeaderInvoiceCode([{ invoice_code: 'TRIV1' }, { invoice_code: null }]),
    null
  );
});

test('resolveHeaderInvoiceCode: no invoices at all -> null', () => {
  assert.strictEqual(resolveHeaderInvoiceCode([{ invoice_code: null }, {}]), null);
});

test('validateSplitTotal: exact match ok', () => {
  const r = validateSplitTotal([{ amount: 11000 }, { amount: 5000 }], 16000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sum, 16000);
});

test('validateSplitTotal: off by more than a cent -> not ok', () => {
  assert.strictEqual(validateSplitTotal([{ amount: 10999 }], 11000).ok, false);
});

test('validateSplitTotal: within a cent -> ok', () => {
  assert.strictEqual(validateSplitTotal([{ amount: 10999.995 }], 11000).ok, true);
});

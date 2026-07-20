/**
 * %Payment frequency% humanisation. Values below are the ones that actually
 * appear in leasing.invoicing (30, empty, 1, 7, 14, 60, 0) plus the word forms.
 * ~34% of leases have no invoicing at all — those are one-time, and must NOT be
 * described as monthly.
 */
const test = require('node:test');
const assert = require('node:assert');
const { formatInvoicingFrequency } = require('../src/services/emailService');

test('empty / null / zero => one-time (no recurring schedule)', () => {
  for (const v of ['', '   ', null, undefined, '0', 0]) {
    assert.equal(formatInvoicingFrequency(v), 'one-time', `value: ${JSON.stringify(v)}`);
  }
});

test('day counts map to readable periods', () => {
  assert.equal(formatInvoicingFrequency('1'), 'daily');      // not "every 1 days"
  assert.equal(formatInvoicingFrequency('7'), 'weekly');
  assert.equal(formatInvoicingFrequency('14'), 'every 2 weeks');
  assert.equal(formatInvoicingFrequency('30'), 'monthly');
  assert.equal(formatInvoicingFrequency('90'), 'quarterly');
  assert.equal(formatInvoicingFrequency('180'), 'every 6 months');
  assert.equal(formatInvoicingFrequency('60'), 'every 60 days');
});

test('word forms map too, case/space insensitive', () => {
  assert.equal(formatInvoicingFrequency('Monthly'), 'monthly');
  assert.equal(formatInvoicingFrequency(' quarterly '), 'quarterly');
  assert.equal(formatInvoicingFrequency('bi-weekly'), 'every 2 weeks');
  assert.equal(formatInvoicingFrequency('bi-annually'), 'every 6 months');
});

test('unrecognised value is surfaced, not blanked', () => {
  assert.equal(formatInvoicingFrequency('fortnightly'), 'fortnightly');
});

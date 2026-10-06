/**
 * Utility invoice wording. The real case: Denzil moved into FLT 2K on 8 Aug 2026,
 * his share of the 18 Jul – 18 Sep bill was worked out from that day, but the
 * invoice (TRIV35429) still said "Period: July 18 - September 18, 2026".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  formatUtilityNote, formatLegacyUtilityNote, tenantPeriod, fmtPeriod, fmtRate,
} = require('../src/utils/utilityInvoiceNote');

const BILL = { period_start: '2026-07-18', period_end: '2026-09-18', rate_per_kw: '1.9200' };
const DENZIL = {
  kw_used: '338.00', gross_amount: '648.96', prorated_credit: '414.25', prorated_days: 42,
  lease_start: '2026-08-08', lease_end: '2026-11-07', meter_number: 'FLT 2K',
};

test('a mid-cycle move-in shows the tenant period, kWh and the allowance with its days', () => {
  assert.equal(formatUtilityNote(BILL, DENZIL),
    'Electricity August 8 - September 18, 2026: 338 kWh × HK$1.92 = HK$648.96, '
    + 'less utility allowance for 42 days -HK$414.25 | Meter: FLT 2K');
});

test('the legacy formatter reproduces the old invoice text byte for byte', () => {
  // Exactly what TRIV35429 says. The backfill only rewrites notes equal to this.
  assert.equal(formatLegacyUtilityNote(BILL, DENZIL),
    'Utility charge: 338.00 kW × $1.9200/kW = $648.96 | Credit: -$414.25 | Meter: FLT 2K '
    + '| Period: July 18 - September 18, 2026');
});

test('a tenant here for the whole cycle keeps the bill period', () => {
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', '2025-01-01', '2027-01-01'),
    { start: '2026-07-18', end: '2026-09-18' });
});

test('a lease ending inside the cycle ends the period on the lease end', () => {
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', '2025-01-01', '2026-08-31'),
    { start: '2026-07-18', end: '2026-08-31' });
});

test('a lease starting and ending inside the cycle uses both lease dates', () => {
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', '2026-08-01', '2026-08-31'),
    { start: '2026-08-01', end: '2026-08-31' });
});

test('missing lease dates leave the bill period alone', () => {
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', null, null),
    { start: '2026-07-18', end: '2026-09-18' });
});

test('a lease date outside the bill does not invert the period', () => {
  // A lease that only starts after the bill ended must not push start past end.
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', '2026-10-01', null),
    { start: '2026-07-18', end: '2026-09-18' });
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', null, '2026-07-01'),
    { start: '2026-07-18', end: '2026-09-18' });
});

test('DATE columns that arrive as local-midnight Date objects keep their day', () => {
  const d = (y, m, day) => new Date(y, m - 1, day);
  assert.deepEqual(tenantPeriod(d(2026, 7, 18), d(2026, 9, 18), d(2026, 8, 8), d(2026, 11, 7)),
    { start: '2026-08-08', end: '2026-09-18' });
  assert.equal(fmtPeriod(d(2026, 8, 8), d(2026, 9, 18)), 'August 8 - September 18, 2026');
});

test('a period across the new year names both years', () => {
  assert.equal(fmtPeriod('2026-12-15', '2027-01-14'), 'December 15, 2026 - January 14, 2027');
});

test('no allowance means no allowance clause; one day is singular', () => {
  assert.doesNotMatch(formatUtilityNote(BILL, { ...DENZIL, prorated_credit: '0.00' }), /allowance/);
  assert.match(formatUtilityNote(BILL, { ...DENZIL, prorated_days: 1 }), /for 1 day -HK\$/);
});

test('rates print without padding but keep real precision', () => {
  assert.equal(fmtRate('1.9200'), '1.92');
  assert.equal(fmtRate('2'), '2.00');
  assert.equal(fmtRate('1.5'), '1.50');
  assert.equal(fmtRate('1.9225'), '1.9225');
});

test('large amounts get thousands separators', () => {
  assert.match(formatUtilityNote(BILL, { ...DENZIL, gross_amount: '12345.6', prorated_credit: '0' }), /= HK\$12,345\.60/);
});

test('generate-invoices writes the note through formatUtilityNote with the full bill line', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/utility.js'), 'utf8');
  const start = src.indexOf("router.post('/bill/:id/generate-invoices'");
  assert.ok(start > 0, 'generate-invoices route exists');
  const body = src.slice(start, src.indexOf('router.', start + 10));
  assert.match(body, /const note = formatUtilityNote\(bill, line\);/);
  // The line must carry lease_start / lease_end / prorated_days for the period.
  assert.match(body, /SELECT bl\.\*, m\.meter_number/);
  assert.doesNotMatch(body, /Utility charge:/);
});

test('the backfill recognises both earlier generated formats and nothing else', () => {
  const { isGeneratedLegacyNote } = require('../src/utils/utilityInvoiceNote');
  const bill = { period_start: '2026-03-25', period_end: '2026-04-24', rate_per_kw: '1.3400' };
  const line = { kw_used: '253.00', gross_amount: '339.02', prorated_credit: '0.00', meter_number: 'Hillier 2B-Quoc Dat Cao' };
  const raw = 'Utility charge: 253.00 kW × $1.3400/kW = $339.02 | Meter: Hillier 2B-Quoc Dat Cao | Period: '
    + 'Wed Mar 25 2026 00:00:00 GMT+0000 (Coordinated Universal Time) to Fri Apr 24 2026 00:00:00 GMT+0000 (Coordinated Universal Time)';
  assert.equal(isGeneratedLegacyNote(raw, bill, line), true);                      // TRIV34077, verbatim
  assert.equal(isGeneratedLegacyNote(formatLegacyUtilityNote(bill, line), bill, line), true);
  // Same text but another bill's dates: not this line's note.
  assert.equal(isGeneratedLegacyNote(raw.replace('Mar 25', 'Mar 26'), bill, line), false);
  // A hand edit anywhere is preserved.
  assert.equal(isGeneratedLegacyNote(raw.replace('253.00 kW', '250.00 kW'), bill, line), false);
  assert.equal(isGeneratedLegacyNote(raw + ' (adjusted)', bill, line), false);
  assert.equal(isGeneratedLegacyNote(null, bill, line), false);
});

test('a raw-Date note with a weekday that date never had is treated as hand-edited', () => {
  const { isGeneratedLegacyNote } = require('../src/utils/utilityInvoiceNote');
  const bill = { period_start: '2026-03-25', period_end: '2026-04-24', rate_per_kw: '1.3400' };
  const line = { kw_used: '253.00', gross_amount: '339.02', prorated_credit: '0.00', meter_number: 'Hillier 2B' };
  const raw = 'Utility charge: 253.00 kW × $1.3400/kW = $339.02 | Meter: Hillier 2B | Period: '
    + 'Wed Mar 25 2026 00:00:00 GMT+0000 (Coordinated Universal Time) to Fri Apr 24 2026 00:00:00 GMT+0000 (Coordinated Universal Time)';
  assert.equal(isGeneratedLegacyNote(raw, bill, line), true);
  assert.equal(isGeneratedLegacyNote(raw.replace('Wed Mar 25', 'Thu Mar 25'), bill, line), false);
});

test('reversed lease dates inside the cycle fall back to the bill period', () => {
  assert.deepEqual(tenantPeriod('2026-07-18', '2026-09-18', '2026-09-01', '2026-08-01'),
    { start: '2026-07-18', end: '2026-09-18' });
});

test('legacy text is identical for Date inputs, numeric zero credit and a missing meter', () => {
  const asDate = { period_start: new Date(2026, 6, 18), period_end: new Date(2026, 8, 18), rate_per_kw: '1.9200' };
  assert.equal(formatLegacyUtilityNote(asDate, DENZIL), formatLegacyUtilityNote(BILL, DENZIL));
  const noCredit = { ...DENZIL, prorated_credit: 0, meter_number: null };
  assert.equal(formatLegacyUtilityNote(BILL, noCredit),
    'Utility charge: 338.00 kW × $1.9200/kW = $648.96 | Meter: N/A | Period: July 18 - September 18, 2026');
  assert.equal(formatLegacyUtilityNote(BILL, { ...noCredit, prorated_credit: '0.00' }), formatLegacyUtilityNote(BILL, noCredit));
});

test('the backfill write re-checks scope and the revert is a single transaction', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/backfillUtilityInvoiceNotes.js'), 'utf8');
  const write = src.slice(src.indexOf('SET i.note = ?'), src.indexOf('[c.new_note, c.invoice_id'));
  for (const guard of ['i.org_id = ?', 'i.note = ?', 'i.status <> 1', 'i.deleted_at IS NULL']) {
    assert.ok(write.includes(guard), `write guards on ${guard}`);
  }
  assert.match(src, /JOIN utility_bill b ON b\.id = bl\.bill_id AND b\.org_id = i\.org_id\s+SET i\.note/);
  const revert = src.slice(src.indexOf('if (revertFile) {'), src.indexOf('const [rows] = await conn.execute(\n      `SELECT i.id'));
  assert.ok(revert.indexOf('beginTransaction') >= 0 && revert.indexOf('beginTransaction') < revert.indexOf('UPDATE invoice'));
  assert.match(revert, /await conn\.commit\(\)/);
  assert.match(src, /backup is written|writeFileSync\(backup/);
  assert.ok(src.indexOf('writeFileSync(backup') < src.indexOf('SET i.note = ?'), 'backup is written before any write');
});

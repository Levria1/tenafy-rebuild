/**
 * Rent due on the 31st must not skip the short months.
 *
 * advanceInvoiceDate added a month with setMonth(m + 1) and clamped to the lease's
 * due day afterwards. On 31 August that asked for 31 September, JavaScript rolled it
 * to 1 October, and the clamp then measured OCTOBER — returning 31 October. September
 * was silently never billed, and the following period ran 31 Oct to 30 Dec, so its
 * prorata covered two months.
 *
 * Live damage in org 8300127259922432 on 2026-09-11, before the fix: five active
 * leases with no September rent invoice at all (Mercer 2A 16,700; Mong Kok 2C 12,000;
 * Poplar 5D 12,000; Poplar 1A 13,500; Poplar 4C 14,500 — HK$68,700), plus two older
 * gaps, plus two invoices priced off the broken walk (TRIV35361 at HK$790 against a
 * HK$12,000 rent, TRIV35217 covering 50 days in one bill).
 *
 * 30 of the org's 222 active monthly recurring leases bill on the 29th, 30th or 31st.
 */

const test = require('node:test');
const assert = require('node:assert');
const { advanceInvoiceDate, periodEndFor } = require('../src/utils/invoiceSchedule');
const { computeRentInvoiceAmount } = require('../src/utils/rentProrata');

const d = (s) => new Date(`${s}T00:00:00Z`);
const f = (x) => x.toISOString().slice(0, 10);

/** Walk n periods forward from a due date, the way the scheduler's loop does. */
function walk(start, schedule, dueDay, n) {
  const out = [];
  let cur = d(start);
  for (let i = 0; i < n; i++) { cur = advanceInvoiceDate(cur, schedule, dueDay); out.push(f(cur)); }
  return out;
}

test('a lease billed on the 31st visits every month', () => {
  // The exact walk that lost September 2026 for five leases.
  assert.deepStrictEqual(walk('2025-03-31', '30', 31, 12), [
    '2025-04-30', '2025-05-31', '2025-06-30', '2025-07-31',
    '2025-08-31', '2025-09-30', '2025-10-31', '2025-11-30',
    '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31',
  ]);
});

test('31 August advances to 30 September, not 31 October', () => {
  // The single step behind TRIV35361. Kept as its own test so a regression names
  // the month it lost.
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), '30', 31)), '2026-09-30');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'monthly', 31)), '2026-09-30');
});

test('a short month clamps but does not drag the schedule down with it', () => {
  // February pulls the 29th back to the 28th; March must return to the 29th
  // rather than staying on the 28th for the rest of the lease.
  assert.deepStrictEqual(walk('2026-01-29', '30', 29, 4),
    ['2026-02-28', '2026-03-29', '2026-04-29', '2026-05-29']);
  assert.deepStrictEqual(walk('2026-01-30', '30', 30, 3),
    ['2026-02-28', '2026-03-30', '2026-04-30']);
});

test('the rollover is fixed for every month-based cycle, not just monthly', () => {
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'bi-monthly', 31)), '2026-10-31');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'quarterly', 31)), '2026-11-30');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), '180', 31)), '2027-02-28');
  assert.strictEqual(f(advanceInvoiceDate(d('2024-02-29'), 'annually', 29)), '2025-02-28');
});

test('a lease with no due day set still does not overflow', () => {
  // dueDay is nullable, and that branch had the same setMonth overflow: 31 Jan
  // used to land on 3 March.
  assert.strictEqual(f(advanceInvoiceDate(d('2026-01-31'), 'monthly', null)), '2026-02-28');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'monthly', 0)), '2026-09-30');
});

test('day-based cycles are untouched', () => {
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'weekly', 31)), '2026-09-07');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'bi-weekly', 31)), '2026-09-14');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), '28', 31)), '2026-09-28');
  assert.strictEqual(f(advanceInvoiceDate(d('2026-08-31'), 'daily', 31)), '2026-09-01');
});

test('a period is one month long, so the final prorata is not doubled', () => {
  // LEA2705, Mong Kok 2C: rent 12,000, due day 31, lease ends 2026-11-01. The
  // broken walk billed 31 Oct over a 31 Oct - 30 Dec period and prorated it to
  // HK$790. September must be billed in full first.
  const sep = advanceInvoiceDate(d('2026-08-31'), '30', 31);
  assert.strictEqual(f(sep), '2026-09-30');
  assert.strictEqual(f(periodEndFor(sep, '30', 31)), '2026-10-30');
  assert.strictEqual(computeRentInvoiceAmount({
    rent: 12000, invoicing: '30', periodStart: sep,
    periodEnd: periodEndFor(sep, '30', 31), leaseEnd: '2026-11-01',
  }), 12000);

  const oct = advanceInvoiceDate(sep, '30', 31);
  assert.strictEqual(f(oct), '2026-10-31');
  // Now a real final stub: 31 Oct to 1 Nov, two days of a 12,000 rent.
  assert.strictEqual(computeRentInvoiceAmount({
    rent: 12000, invoicing: '30', periodStart: oct,
    periodEnd: periodEndFor(oct, '30', 31), leaseEnd: '2026-11-01',
  }), 790);
});

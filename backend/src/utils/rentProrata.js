/**
 * Rent invoice amount calculator, with prorata on the final period when the
 * lease ends mid-period.
 *
 * Rule (from the user, Apr 2026):
 *   Only the LAST period of a lease may be prorated — when lease.end_date
 *   falls before the period's natural end.
 *
 *   days_stayed   = lease.end_date - (period_start - 1)      // inclusive count
 *   daily_rate    = rent × (periods_per_year / 365)
 *   raw_amount    = daily_rate × days_stayed
 *   final_amount  = Math.round(raw_amount / 10) × 10         // nearest $10, half-up
 *
 *   Example: monthly rent $16,800, lease ends June 10, current period starts
 *   June 1. days_stayed = 10. daily = 16800×12/365 = 552.3288. raw = 5523.29.
 *   Rounded to nearest 10 = $5,520.
 */

// Billing cycles we understand. Values are periods per year.
// Keys match both the numeric and string forms of `leasing.invoicing`.
const PERIODS_PER_YEAR = {
  '1':            365,
  'daily':        365,
  '7':            52,
  'weekly':       52,
  '14':           26,
  'bi-weekly':    26,
  '28':           13,
  '30':           12,
  'monthly':      12,
  '60':           6,
  'bi-monthly':   6,
  '90':           4,
  'quarterly':    4,
  '180':          2,
  'bi-annually':  2,
  '365':          1,
  'annually':     1,
};

function periodsPerYear(invoicing) {
  const key = String(invoicing || '').toLowerCase();
  return PERIODS_PER_YEAR[key] || 12; // default to monthly if unknown
}

// Number of days from a → b, inclusive (both ends counted). Dates at the same
// day → 1. b must be >= a. Uses UTC midnight to avoid DST/tz drift.
function inclusiveDays(a, b) {
  const aUtc = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bUtc = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((bUtc - aUtc) / 86400000) + 1;
}

function toDateOnly(d) {
  if (d instanceof Date) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // parse YYYY-MM-DD as UTC midnight (avoids local-tz off-by-one)
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, day || 1));
}

/**
 * Compute the amount for one rent invoice.
 *
 * @param {object} opts
 * @param {number|string} opts.rent        - monthly (or per-cycle) rent amount
 * @param {string|number} opts.invoicing   - billing frequency (monthly, weekly, etc.)
 * @param {Date|string}   opts.periodStart - this invoice's due date (period start)
 * @param {Date|string}   opts.periodEnd   - last day of this invoice's period
 *                                            (i.e. day before the next due date)
 * @param {Date|string|null} opts.leaseEnd - the lease end_date (nullable)
 * @returns {number|null} rounded amount, or null if the lease ended before this
 *                        period started (caller should skip issuing the invoice)
 */
function computeRentInvoiceAmount({ rent, invoicing, periodStart, periodEnd, leaseEnd }) {
  const fullAmount = Number(rent) || 0;
  if (!fullAmount) return 0;

  // Open-ended lease (no end date) → always full
  if (!leaseEnd) return fullAmount;

  const pStart = toDateOnly(periodStart);
  const pEnd   = toDateOnly(periodEnd);
  const end    = toDateOnly(leaseEnd);

  // Lease ends on/after period end → full period
  if (end >= pEnd) return fullAmount;

  // Lease ended before this period even started → skip (shouldn't be called)
  if (end < pStart) return null;

  // Partial period — prorate
  const days = inclusiveDays(pStart, end);
  const ppy  = periodsPerYear(invoicing);
  const dailyRate = (fullAmount * ppy) / 365;
  const raw  = dailyRate * days;

  // Round to nearest 10, half-up (JS Math.round rounds half toward +Infinity,
  // which matches "half-up" for positive amounts — e.g. 375/10=37.5 → 38 → 380).
  return Math.round(raw / 10) * 10;
}

module.exports = { computeRentInvoiceAmount, periodsPerYear, inclusiveDays };

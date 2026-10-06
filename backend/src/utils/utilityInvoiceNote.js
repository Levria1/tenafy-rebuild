/**
 * The line a tenant reads on a utility invoice.
 *
 * Two things this gets right that the old one-liner in routes/utility.js did not:
 *
 * 1. The PERIOD is the tenant's own share of the bill. A bill covers the meter's
 *    whole cycle (say 18 Jul – 18 Sep), but a tenant who moved in on 8 Aug was only
 *    charged from their move-in reading, and their allowance was pro-rated from that
 *    day too. Printing "July 18 - September 18" on their first bill made it look as
 *    if they were paying for weeks before they lived there. 40 of the first 201
 *    utility invoices started mid-cycle like that.
 * 2. Usage is kWh (energy), not kW (power), and the credit is named for what it is:
 *    the utility allowance in the lease, pro-rated over the days it covers.
 *
 * `formatLegacyUtilityNote` reproduces the old text exactly. The backfill uses it to
 * recognise a note nobody has edited by hand, so it never overwrites a manual note.
 */

const PERIOD_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// DATE columns arrive as 'YYYY-MM-DD' strings (dateStrings) or local-midnight Dates.
// Read wall-clock parts either way so the stored day survives any server TZ.
function toYmd(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function fmtPeriod(start, end) {
  const a = toYmd(start), b = toYmd(end);
  if (!a || !b) return `${start ?? ''} to ${end ?? ''}`.trim();
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const md = (m, d) => `${PERIOD_MONTHS[m - 1]} ${d}`;
  return ay === by ? `${md(am, ad)} - ${md(bm, bd)}, ${by}` : `${md(am, ad)}, ${ay} - ${md(bm, bd)}, ${by}`;
}

/**
 * The part of the bill period the tenant's lease covers: the later of the two starts
 * and the earlier of the two ends. A lease date outside the bill period (or missing)
 * leaves the bill's own boundary in place.
 */
function tenantPeriod(billStart, billEnd, leaseStart, leaseEnd) {
  const bs = toYmd(billStart), be = toYmd(billEnd);
  const ls = toYmd(leaseStart), le = toYmd(leaseEnd);
  let start = bs, end = be;
  if (ls && bs && ls > bs && (!be || ls <= be)) start = ls;
  if (le && be && le < be && (!bs || le >= bs)) end = le;
  // Inconsistent lease snapshots (end before start) must not print "September 1 -
  // August 1"; the bill's own period is at least true.
  if (start && end && start > end) return { start: bs, end: be };
  return { start, end };
}

// 1.92 rather than 1.9200; keep extra places only when the rate really has them.
function fmtRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return String(rate);
  const s = n.toFixed(4).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}00` : (s.split('.')[1].length < 2 ? `${s}0` : s);
}

function money(n) {
  return `HK$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * @param {object} bill  utility_bill row: period_start, period_end, rate_per_kw
 * @param {object} line  utility_bill_line row (+ meter_number): kw_used, gross_amount,
 *                       prorated_credit, prorated_days, lease_start, lease_end
 */
function formatUtilityNote(bill, line) {
  const { start, end } = tenantPeriod(bill.period_start, bill.period_end, line.lease_start, line.lease_end);
  const credit = Number(line.prorated_credit) || 0;
  const days = Number(line.prorated_days) || 0;
  let note = `Electricity ${fmtPeriod(start, end)}: ${Number(line.kw_used)} kWh × HK$${fmtRate(bill.rate_per_kw)}`
    + ` = ${money(line.gross_amount)}`;
  if (credit > 0) {
    note += `, less utility allowance${days > 0 ? ` for ${days} day${days === 1 ? '' : 's'}` : ''} -${money(credit)}`;
  }
  note += ` | Meter: ${line.meter_number || 'N/A'}`;
  return note;
}

/** Byte-for-byte the note generate-invoices wrote before this change. */
function formatLegacyUtilityNote(bill, line) {
  return `Utility charge: ${line.kw_used} kW × $${Number(bill.rate_per_kw).toFixed(4)}/kW = $${Number(line.gross_amount).toFixed(2)}` +
    (Number(line.prorated_credit) > 0 ? ` | Credit: -$${Number(line.prorated_credit).toFixed(2)}` : '') +
    ` | Meter: ${line.meter_number || 'N/A'}` +
    ` | Period: ${fmtPeriod(bill.period_start, bill.period_end)}`;
}

// Before fmtPeriod existed (spring 2026) the period was interpolated straight from the
// mysql2 Date objects, so the note carried Date.toString() on a UTC server:
//   "| Period: Wed Mar 25 2026 00:00:00 GMT+0000 (Coordinated Universal Time) to Fri Apr 24 2026 …"
// Six unpaid invoices still say that. Recognise it only when the two dates in it are
// exactly this bill's dates, so nothing else can be mistaken for a generated note.
const DATE_TOSTRING = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{2}) (\d{4}) 00:00:00 GMT\+0000 \(Coordinated Universal Time\)$/;
const SHORT_MONTHS = PERIOD_MONTHS.map(m => m.slice(0, 3));
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dateToStringYmd(s) {
  const m = DATE_TOSTRING.exec(s);
  if (!m) return null;
  const mi = SHORT_MONTHS.indexOf(m[2]);
  if (mi < 0) return null;
  // Date.toString() could only have printed the weekday that date really fell on;
  // any other weekday means a person typed it, so it is not a generated note.
  const weekday = SHORT_DAYS[new Date(Date.UTC(Number(m[4]), mi, Number(m[3]))).getUTCDay()];
  if (weekday !== m[1]) return null;
  return `${m[4]}-${String(mi + 1).padStart(2, '0')}-${m[3]}`;
}

/** True when `note` is exactly what either earlier generator wrote for this line. */
function isGeneratedLegacyNote(note, bill, line) {
  if (note === formatLegacyUtilityNote(bill, line)) return true;
  const legacy = formatLegacyUtilityNote(bill, line);
  const prefix = legacy.slice(0, legacy.lastIndexOf(' | Period: ') + ' | Period: '.length);
  if (typeof note !== 'string' || !note.startsWith(prefix)) return false;
  const parts = note.slice(prefix.length).split(' to ');
  if (parts.length !== 2) return false;
  return dateToStringYmd(parts[0]) === toYmd(bill.period_start)
    && dateToStringYmd(parts[1]) === toYmd(bill.period_end)
    && toYmd(bill.period_start) !== null;
}

module.exports = {
  formatUtilityNote, formatLegacyUtilityNote, isGeneratedLegacyNote, tenantPeriod, fmtPeriod, fmtRate,
};

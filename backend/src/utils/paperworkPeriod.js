/**
 * Whether a lease's term is covered by signed paperwork, and if not, whether
 * the uncovered stretch is long enough to need a document.
 *
 * Pure — no DB, no Express — so the threshold rule is testable on its own.
 *
 * The rule: an uncovered stretch of A MONTH OR MORE needs a signed document.
 * It is measured from the last SIGNED period, never from the last edit, so a
 * run of short month-to-month rollovers cannot quietly accumulate into an
 * undocumented year.
 */

// Wall-clock YYYY-MM-DD. mysql2 hands back DATE columns as LOCAL-midnight Date
// objects; toISOString() would shift the day west of UTC. Same convention as
// ymd() in services/leaseTemplateVariables.js.
function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function parts(dateStr) {
  const s = ymd(dateStr);
  if (!s) return null;
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function fromUtc(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// Calendar arithmetic in UTC so no timezone can shift the resulting date.
function addDays(dateStr, n) {
  const p = parts(dateStr);
  if (!p) return '';
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

// The last day of a one-month period that STARTS on dateStr.
// The day is clamped to the target month's length before subtracting, matching
// defaultStampEndDate, dayjs .add(1,'month') and MySQL DATE_ADD.
function addOneMonthMinusDay(dateStr) {
  const p = parts(dateStr);
  if (!p) return '';
  const targetY = p.m === 12 ? p.y + 1 : p.y;
  const targetM = p.m === 12 ? 1 : p.m + 1;
  const lastDay = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate();
  const dt = new Date(Date.UTC(targetY, targetM - 1, Math.min(p.d, lastDay)));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return fromUtc(dt);
}

const isSigned = (doc) => Number(doc.status) === 3;
const isInFlight = (doc) => Number(doc.status) === 1 || Number(doc.status) === 2;

/**
 * @param {object}   input
 * @param {*}        input.leaseEndDate  leasing.end_date (string, Date or null)
 * @param {Array}    input.documents     [{ status, term_start, term_end }]
 */
function computePaperworkState({ leaseEndDate, documents }) {
  const all = Array.isArray(documents) ? documents : [];
  // Only SIGNED or IN-FLIGHT documents opt a lease in. A lease whose sole
  // request was cancelled or declined never got papered, so treating it as
  // "documented" would nag about an abandoned attempt.
  const docs = all.filter(d => isSigned(d) || isInFlight(d));
  const leaseEnd = ymd(leaseEndDate);

  const base = {
    has_documents: docs.length > 0,
    covered_end: null,
    next_period_start: null,
    in_flight: false,
    uncovered: null,
    needs_document: false,
    reason: 'no_documents',
  };

  if (!docs.length) return base;

  const signedEnds = docs.filter(isSigned).map(d => ymd(d.term_end)).filter(Boolean);
  signedEnds.sort();
  const coveredEnd = signedEnds.length ? signedEnds[signedEnds.length - 1] : null;
  base.covered_end = coveredEnd;

  // Something out for signature suppresses the flag — including a request with
  // no recorded period, so pre-existing requests do not nag while in flight.
  base.in_flight = docs.some(d =>
    isInFlight(d) && (!ymd(d.term_end) || (leaseEnd && ymd(d.term_end) >= leaseEnd))
  );
  if (base.in_flight) return { ...base, reason: 'in_flight' };

  // An open-ended lease has no end to measure against.
  if (!leaseEnd) return { ...base, reason: 'covered' };

  // Documented, but we cannot tell which period — ask for it rather than guess.
  if (!coveredEnd) return { ...base, needs_document: true, reason: 'period_not_recorded' };

  if (leaseEnd <= coveredEnd) return { ...base, reason: 'covered' };

  const nextStart = addDays(coveredEnd, 1);
  const threshold = addOneMonthMinusDay(nextStart);
  const long = leaseEnd >= threshold;

  return {
    ...base,
    next_period_start: nextStart,
    uncovered: { from: nextStart, to: leaseEnd },
    needs_document: long,
    reason: long ? 'gap' : 'under_a_month',
  };
}

module.exports = { ymd, addDays, addOneMonthMinusDay, computePaperworkState };

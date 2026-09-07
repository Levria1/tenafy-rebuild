/**
 * Rules for meter readings, kept out of the route so they can be tested for
 * behaviour rather than by matching the text of the handler.
 *
 * A utility meter carries the same number in two places: utility_meter.
 * current_reading (a denormalised column) and utility_meter_reading (the log).
 * The screen shows the latest log row BY DATE; bill creation takes the highest of
 * the log, the last finalized bill ending, and the column. Keeping the two honest
 * is what these rules are for.
 */

// utility_meter_reading.reading_type — 0 Move-In, 1 Move-Out, 2 Billing,
// 3 Monthly, 4 Correction (made from the Edit Meter form). tinyint, no migration.
const READING_TYPE_CORRECTION = 4;

/**
 * Normalise a reading date to the YYYY-MM-DD that a DATE column accepts.
 *
 * reading_date is a DATE. A caller sending a full ISO timestamp
 * ('2026-09-07T23:30:00.000Z') would push a value MySQL may reject outright in
 * strict mode, and whose UTC day can differ from the org's day — the same
 * two-meanings trap that DATETIME columns carry elsewhere in this schema.
 *
 * Returns null for anything that is not a usable date, so the caller can answer
 * 400 instead of letting the database decide.
 */
function normaliseReadingDate(input, today) {
  if (input === undefined || input === null || input === '') return today;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${input.getFullYear()}-${p(input.getMonth() + 1)}-${p(input.getDate())}`;
  }
  const s = String(input).trim();
  if (!s) return today;
  // Take the date part of an ISO timestamp; require a real calendar date.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() + 1 !== Number(mo) || dt.getUTCDate() !== Number(d)) {
    return null; // 2026-02-30 and friends
  }
  return `${y}-${mo}-${d}`;
}

/**
 * A reading value must be a finite, non-negative number.
 *
 * Without this, 'abc' became NaN, compared unequal to everything, and was sent
 * to a DECIMAL(12,2) column. Returns null when the input cannot be used.
 */
function parseReadingValue(input) {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Is the submitted value a correction of what the form displayed?
 *
 * `shown` is the latest reading BY DATE, which is what the form was prefilled
 * with — NOT the meter column. Comparing against the column would log a
 * correction nobody asked for every time an unrelated field was edited on a meter
 * where the two disagree.
 */
function isCorrection(shown, submitted) {
  if (submitted === null) return false;
  return Number(submitted) !== Number(shown);
}

module.exports = { READING_TYPE_CORRECTION, normaliseReadingDate, parseReadingValue, isCorrection };

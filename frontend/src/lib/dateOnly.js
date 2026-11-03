/**
 * Format a calendar date ("2027-01-01") exactly as stored, in any timezone.
 *
 * `new Date('2027-01-01')` is midnight UTC, and toLocaleDateString then shifts
 * it into the viewer's timezone. In the tenant portal that showed a lease
 * running 1–31 Jan 2027 as "Dec 31, 2026 – Jan 30, 2027" on a phone set to an
 * American timezone. Lease dates, due dates and payment dates are MySQL DATE
 * columns, served as plain "YYYY-MM-DD" strings, so they have no time of day to
 * convert: read the three numbers and format them in UTC, where nothing shifts.
 */
export function formatDateOnly(value, { fallback = 'N/A', month = 'short' } = {}) {
  if (!value) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return String(value);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    .toLocaleDateString('en-US', { year: 'numeric', month, day: 'numeric', timeZone: 'UTC' });
}

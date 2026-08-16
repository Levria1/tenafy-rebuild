// The operator's clock.
//
// Production (the droplet, node and MySQL) runs Etc/UTC. The operator, the tenants
// and the TaneChat partner all work in Hong Kong (UTC+8). Every business date in
// this system — an invoice due date, a lease end date, "is this viewing today" —
// is a Hong Kong calendar date, so deriving one from the server clock is wrong for
// eight hours out of every twenty-four.
//
// An IANA zone rather than a fixed +480 offset: HK has no DST so the numbers match
// today, but a fixed offset silently rots the first time this runs elsewhere.
//
// We deliberately do NOT set process.env.TZ. It looks like the one-line fix and it
// would be a disaster: mysql2 parses stored DATETIMEs against the process timezone,
// so flipping it reinterprets every timestamp already in the database by 8 hours.
// Convert only the instants we generate, at the point of comparison.
const ORG_TIME_ZONE = process.env.ORG_TIME_ZONE || 'Asia/Hong_Kong';

// 'YYYY-MM-DDTHH:MM:SS' in the operator's zone.
function orgWallClock(instant = new Date(), timeZone = ORG_TIME_ZONE) {
  const d = (instant instanceof Date) ? instant : new Date(instant);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  // Intl renders midnight as hour "24" in some ICU versions; normalise it.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${p(hour)}:${parts.minute}:${parts.second}`;
}

// Accepts either a real instant (Date) or a value that is ALREADY operator wall
// clock (a 'YYYY-MM-DDTHH:MM' string, which is how prospect times and tests carry
// them). Only an instant needs converting; converting a wall-clock string again
// would shift it a second time.
function toOrgWallClock(value) {
  if (value instanceof Date) return orgWallClock(value);
  return value;
}

// The operator's calendar date, 'YYYY-MM-DD'. This is what "today" means for every
// business rule, and what to bind in place of SQL CURDATE() (which resolves against
// the MySQL server's zone, i.e. UTC).
function orgToday(instant = new Date()) {
  const wall = orgWallClock(instant);
  return wall ? wall.slice(0, 10) : null;
}

// `orgToday` as a Date for day arithmetic.
//
// Anchored at UTC midnight, because 'YYYY-MM-DD' always parses as UTC — which is
// also how scheduler.js already anchors the dates it compares against
// (`new Date(toDateString(someDbDate))`). Both sides of every comparison must come
// through a string round-trip or the anchors disagree by the local offset.
function orgTodayDate(instant = new Date()) {
  const today = orgToday(instant);
  return today ? new Date(today) : null;
}

// `orgToday` as a quoted SQL literal, e.g. `'2026-08-16'`. Drop this in wherever a
// query used to say CURDATE().
//
// Inlining rather than binding a `?` is deliberate. Most of these queries are built
// by string concatenation — a WHERE clause assembled from optional filters, a CASE
// in the SELECT list, a shared fragment interpolated into several statements. Adding
// placeholders to those means keeping a params array in step with the SQL by hand,
// and getting the order wrong there is both silent and severe: MySQL would happily
// compare a date column against an org id. Inlining removes that entire class of
// mistake, and the value is one this module generated, never anything a caller sent.
//
// The regex is not decoration. It is the reason inlining is safe, so it is enforced
// here rather than assumed — and it throws rather than degrade, because emitting SQL
// we cannot vouch for would turn a clock problem into a wrong-results problem.
function orgTodaySql(instant = new Date()) {
  return sqlDateLiteral(orgToday(instant));
}

// Quote a 'YYYY-MM-DD' for inlining, refusing anything else.
//
// Shape is checked AND the date is round-tripped, because the regex alone would
// wave through '2026-02-30'. Split out from orgTodaySql so the rejection path is
// reachable from a test — orgToday() cannot be made to emit a bad date on demand.
function sqlDateLiteral(date) {
  // Parsed first and checked for NaN, because '2026-13-01' yields an Invalid Date
  // whose toISOString() throws a RangeError before any comparison can run.
  const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00Z`)
    : null;
  const ok = parsed && !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === date;
  if (!ok) {
    throw new Error(`sqlDateLiteral: refusing to build SQL from a malformed date: ${JSON.stringify(date)}`);
  }
  return `'${date}'`;
}

// The calendar date a DATE column holds, 'YYYY-MM-DD'.
//
// mysql2 parses a DATE into `new Date(y, m-1, d)` — LOCAL midnight — so the local
// getters are the only zone-safe way to read one back. `toISOString()` on that value
// lands on the previous day anywhere east of UTC, which is the off-by-one this
// exists to prevent.
//
// This is NOT orgToday(). orgToday() answers "what day is it in Hong Kong"; dbDate()
// answers "what day does this stored value mean". They coincide by accident and
// diverge under load, so keep them apart.
function dbDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  if (typeof value === 'string') {
    const s = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  return null;
}

// The operator's current offset from UTC, in seconds (28800 for Hong Kong).
//
// Derived rather than hardcoded: read the wall clock, re-read those same digits
// as if they were UTC, and the gap is the offset. Costs nothing and keeps working
// if ORG_TIME_ZONE is ever pointed at a zone that observes DST.
function orgUtcOffsetSeconds(instant = new Date()) {
  const wall = orgWallClock(instant);
  // Throws rather than falling back to 0. A silent zero means "UTC", which is
  // precisely the bug this module exists to remove — it would look like a working
  // conversion while shifting nothing.
  if (!wall) {
    throw new Error(`orgUtcOffsetSeconds: could not read the wall clock for ${String(instant)}`);
  }
  const parsed = Date.parse(`${wall}Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`orgUtcOffsetSeconds: unparseable wall clock ${JSON.stringify(wall)}`);
  }
  // Rounded to whole minutes because the wall clock carries no milliseconds; real
  // UTC offsets are always a whole number of minutes (including the 30- and
  // 45-minute ones, which this handles without special casing).
  return Math.round((parsed - instant.getTime()) / 60000) * 60;
}

// Wrap a SQL expression holding a TIMESTAMP — an absolute instant — so it comes out
// as the operator's wall clock.
//
// ONLY for TIMESTAMP columns. Do NOT wrap a DATETIME: in this schema those hold a
// wall clock that is ALREADY Hong Kong (appointment times such as
// viewing_booking.proposed_datetime and service.service_date_start), so shifting one
// moves an evening viewing to the next day. Do NOT wrap a DATE either — see dbDate.
//
// A TIMESTAMP is an absolute instant that MySQL renders in the CONNECTION's
// timezone — UTC here — so formatting one straight out of the database shows a
// London reading to a Hong Kong reader, and the wrong DATE from midnight to 08:00.
//
// The shift subtracts the connection's own offset instead of assuming it is UTC,
// so this survives someone changing the MySQL session timezone later. CONVERT_TZ
// with named zones is deliberately avoided: it returns NULL — silently, with no
// error — unless the server's timezone tables have been loaded, and a NULL date
// reads as "never" rather than as a failure.
//
// Only for true instants. A DATE column carries no timezone and must never be put
// through this; use dbDate() for those.
//
// The offset is TODAY'S offset, applied to every row. Hong Kong has observed no
// DST since 1979, so historical rows convert correctly. Pointing ORG_TIME_ZONE at
// a zone that does observe DST would render pre-transition timestamps an hour out.
function orgTimeSql(expr, instant = new Date()) {
  const offset = orgUtcOffsetSeconds(instant);
  return `DATE_ADD(${expr}, INTERVAL (${offset} - TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW())) SECOND)`;
}

module.exports = {
  ORG_TIME_ZONE, orgWallClock, toOrgWallClock, orgToday, orgTodayDate,
  orgTodaySql, sqlDateLiteral, dbDate, orgUtcOffsetSeconds, orgTimeSql,
};

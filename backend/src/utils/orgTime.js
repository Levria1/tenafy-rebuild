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

module.exports = {
  ORG_TIME_ZONE, orgWallClock, toOrgWallClock, orgToday, orgTodayDate,
  orgTodaySql, sqlDateLiteral, dbDate,
};

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

module.exports = { ORG_TIME_ZONE, orgWallClock, toOrgWallClock, orgToday, orgTodayDate };

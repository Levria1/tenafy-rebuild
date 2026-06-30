/**
 * Viewing availability window — single source of truth, shared by the public
 * booking routes (viewingPublic.js), the bot endpoints (public.js), and (in
 * spirit) the frontend pickers.
 *
 * Viewings: Monday–Saturday, 11:00 AM – 7:00 PM. Sunday is closed. The "7 PM"
 * boundary is the END of the viewing, so the latest start for a 30-min slot is
 * 18:30.
 *
 * The datetime is parsed as a literal wall-clock value (what the viewer picked)
 * rather than going through Date's timezone coercion, so the rule applies
 * consistently regardless of server TZ.
 */

const VIEWING_OPEN_MIN = 11 * 60;   // 11:00
const VIEWING_CLOSE_MIN = 19 * 60;  // 19:00 (7 PM) — last end time

function validateBookingSlot(datetimeStr, durationMinutes = 30) {
  const m = String(datetimeStr).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return 'Invalid date/time format';
  const [, yyyy, mm, dd, HH, MM] = m;
  // Compute day-of-week in UTC to avoid server-TZ shifts on the calendar date.
  const dow = new Date(Date.UTC(+yyyy, +mm - 1, +dd)).getUTCDay(); // 0=Sun
  if (dow === 0) return 'Viewings are not available on Sundays';
  const startMin = +HH * 60 + +MM;
  if (startMin < VIEWING_OPEN_MIN) return 'Viewings start from 11:00 AM';
  if (startMin + durationMinutes > VIEWING_CLOSE_MIN) {
    return 'Viewings must end by 7:00 PM';
  }
  return null;
}

module.exports = { VIEWING_OPEN_MIN, VIEWING_CLOSE_MIN, validateBookingSlot };

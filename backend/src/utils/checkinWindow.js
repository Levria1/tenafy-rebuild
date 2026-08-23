/**
 * When a check-in email is due — in one place, and testable without a clock.
 *
 * Two callers need this answer and used to compute it two different ways:
 *
 *   scheduler.js  swept every upcoming lease at 07:00 Hong Kong and subtracted
 *                 the template's `date_first` from the start date.
 *   leasing.js    fired immediately at lease creation, dividing a millisecond
 *                 difference by 86,400,000 and rounding.
 *
 * Equivalent on paper, and equivalent in practice only for as long as both sides
 * anchored their dates the same way — which nothing enforced. One fed itself Date
 * objects out of MySQL (local midnight), the other a 'YYYY-MM-DD' string off the
 * request body (UTC midnight); the rounding hid the eight-hour gap rather than
 * fixing it. Now there is one comparison and it cannot drift.
 *
 * Everything below works on CALENDAR DATES, never instants. "Does this lease start
 * within N days of today" is a question about days on a wall calendar. What hour
 * the mail actually leaves is decided elsewhere — by the cron schedule, or by the
 * moment staff hit save.
 */

// Reduce whatever a caller has to a 'YYYY-MM-DD' calendar date, or null.
//
// A Date here is almost always a MySQL DATE column, and mysql2 builds those with
// `new Date(y, m, d)` — LOCAL midnight. So the local getters are the ones that
// read back the date the database actually stored. getUTC* would report the
// previous day on every machine east of Greenwich, which is every machine the
// operator uses.
function toCalendarDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return match ? match[0] : null;
}

// Whole days since the epoch. Date.UTC is used purely as day arithmetic against a
// fixed anchor — no local offset and no DST, so subtracting two of these always
// yields whole days rather than 23- or 25-hour approximations.
function dayNumber(calendarDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate || '');
  if (!m) return null;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const back = new Date(ms);
  // Rejects '2026-02-30', which Date.UTC silently rolls forward to 2 March.
  if (back.getUTCMonth() + 1 !== Number(mo) || back.getUTCDate() !== Number(d)) return null;
  return Math.round(ms / 86400000);
}

// Days from `today` to `startDate`. Negative once the lease has started.
function daysUntilStart(startDate, today) {
  const start = dayNumber(toCalendarDate(startDate));
  const now = dayNumber(toCalendarDate(today));
  if (start === null || now === null) return null;
  return start - now;
}

// A missing, unparseable or negative `date_first` means "no lead time" — send on
// the start date itself and not before.
//
// For 0, null and nonsense this matches the `Number(x) || 0` both call sites used.
// For a NEGATIVE value it deliberately does not: the old code let -5 through, and
// `days <= -5` is unsatisfiable for days >= 0, so the email silently never sent.
// The column is a tinyint and the UI enforces min=0, so nothing in production can
// reach this — but "no lead time" is a better reading of a nonsense value than
// "never send anything, without saying so".
function normaliseLeadDays(leadDays) {
  const lead = Number(leadDays);
  return Number.isFinite(lead) && lead > 0 ? Math.floor(lead) : 0;
}

// The lead time is a LOWER bound, not an exact day. The sweep must still send for
// a lease it first sees at start-3, because at start-14 that lease did not exist
// yet — hence `<=` rather than `===`. The start date itself is inside the window
// so a same-day move-in still gets its email.
function isWithinCheckinWindow(startDate, today, leadDays) {
  const days = daysUntilStart(startDate, today);
  if (days === null) return false;
  return days >= 0 && days <= normaliseLeadDays(leadDays);
}

// `tenant_checkin` is a MySQL bit(1), and mysql2 hands those back as a one-byte
// Buffer. `Boolean(buffer)` is true even when the bit is 0, which is the single
// most common way this column gets misread — so decode it explicitly.
function bitToBool(value) {
  if (Buffer.isBuffer(value)) return value.length > 0 && value[0] !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    return t !== '' && t !== '0' && t !== 'false';
  }
  return Number(value) > 0;
}

/**
 * Every gate on an immediate check-in send, in one place.
 *
 * The route path and the nightly sweep have to agree on these or a tenant gets two
 * emails or none. The sweep spells the first two gates in SQL (`lease_state =
 * 'active' AND tenant_checkin = 1`); this is that same pair, applied to a row
 * already in hand.
 *
 * Returns `{ send, reason }` rather than a bare boolean so the caller can log WHY
 * nothing went out — "no email arrived" is otherwise indistinguishable from
 * "nothing tried to send one".
 *
 * `leaseState` is REQUIRED, and an absent one refuses the send. Making it optional
 * was the first draft, on the reasoning that both callers know the state — but that
 * makes a caller who forgets it silently mail an unconfirmed tenant, which is the
 * exact bug this function exists to close. A missed email is recoverable by the
 * 07:00 sweep. An email about a tenancy that never happened is not.
 */
function shouldSendCheckinNow({ leaseState, tenantCheckin, startDate, today, leadDays }) {
  if (!bitToBool(tenantCheckin)) return { send: false, reason: 'checkin_disabled' };

  // A pending lease is one nobody has confirmed yet. Sending check-in instructions
  // for a tenancy that may still fall through is worse than sending late, and the
  // nightly sweep already refuses to. Nothing is lost by waiting: the confirm
  // endpoint calls straight back here the moment the state flips.
  if (leaseState !== 'active') return { send: false, reason: 'lease_not_active' };

  const days = daysUntilStart(startDate, today);
  if (days === null) return { send: false, reason: 'no_start_date' };

  // Backdated leases never send. Check-in instructions that arrive after move-in
  // are worse than none, and the sweep has always excluded them for the same
  // reason — this keeps the two paths saying the same thing.
  if (days < 0) return { send: false, reason: 'already_started' };

  if (days > normaliseLeadDays(leadDays)) return { send: false, reason: 'outside_window' };
  return { send: true, reason: 'in_window' };
}

/**
 * Whether the check-in FOLLOW-UP is due — the second nudge configured as
 * `date_second` on the same Check-In template, mirroring how Invoice-Tenant has
 * always read two lead times off one template.
 *
 * Three conditions beyond the obvious ones, and each exists for a case that would
 * otherwise send a wrong or pointless email:
 *
 *   `firstSentOn` must exist. A "follow-up" to an email that never went is just a
 *   late first email, and the first leg's own window is what should decide that.
 *
 *   The first email must have gone out MORE than `followUpDays` before the start
 *   date. Without this, a lease keyed in two days before move-in fires the first
 *   email on the spot and then a near-identical follow-up the next morning. The
 *   operator asking for "14 days, then 3" means a reminder after a gap; when the
 *   whole tenancy was booked inside that gap there is nothing to remind about.
 *
 *   A window rather than an exact day, so a sweep that does not run on the right
 *   morning still catches up instead of skipping the nudge silently.
 *
 * Returns `{ send, reason }` on the same contract as shouldSendCheckinNow.
 */
function shouldSendCheckinFollowUp({ leaseState, tenantCheckin, startDate, today, followUpDays, firstSentOn }) {
  const lead = normaliseLeadDays(followUpDays);
  // Zero is the "off" value the UI writes for an unset second email, so an
  // operator who never wanted a follow-up never gets one.
  if (lead <= 0) return { send: false, reason: 'no_follow_up_configured' };

  const first = shouldSendCheckinNow({ leaseState, tenantCheckin, startDate, today, leadDays: lead });
  if (!first.send) return first;

  if (!firstSentOn) return { send: false, reason: 'first_email_not_sent' };

  const gap = daysUntilStart(startDate, firstSentOn);
  if (gap === null) return { send: false, reason: 'first_email_date_unreadable' };
  if (gap <= lead) return { send: false, reason: 'no_gap_to_follow_up' };

  return { send: true, reason: 'follow_up_due' };
}

module.exports = {
  toCalendarDate,
  shouldSendCheckinFollowUp,
  daysUntilStart,
  normaliseLeadDays,
  isWithinCheckinWindow,
  bitToBool,
  shouldSendCheckinNow,
};

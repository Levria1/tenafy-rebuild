/**
 * Whether a lease may be switched to status 0 ("Inactive").
 *
 * `leasing.status` is not the status anyone sees. The Leasing list derives
 * Active / Upcoming / Inactive from the DATES (see computedStatusSql), and
 * ignores this column entirely. What the column actually does is decide whether
 * the lease is PROCESSED AT ALL: every scheduler job and every availability
 * query filters `l.status = 1`. Setting it to 0 therefore stops rent invoices,
 * stops check-in/check-out/renewal mail, and hands the unit to the advertising
 * and chatbot search as empty stock — silently, and with no trace in the list.
 *
 * That is the correct outcome for a lease record that should never have existed
 * (a duplicate, a keying error, a booking that fell through before it started).
 * It is the wrong outcome for a tenant who is leaving early, which is what the
 * "Inactive (Terminated)" label invited people to use it for. Three occupied
 * flats reached production this way: two stopped being invoiced, and all three
 * were advertised as vacant while somebody lived in them — two of them
 * discounted 10%, because the ladder read them as long-empty.
 *
 * The move-out flow is the one that ends a tenancy early. It shortens
 * `end_date`, snapshots the original term so it can be undone, records the date,
 * reason and notes, and previews the remaining invoices so they can be settled
 * or dropped deliberately. None of that happens here.
 *
 * So: refuse to void a lease whose term still has time to run, and say where to
 * go instead. A lease that has already ended is unaffected — voiding those is
 * what the column has always been used for (1,800 of them, every single one with
 * an end date in the past).
 */

// 'YYYY-MM-DD' from a string or a MySQL DATE. Local getters, because mysql2
// builds DATE columns with new Date(y, m, d) — local midnight. See
// utils/checkinWindow.js for the same reasoning at more length.
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

const MESSAGE =
  'This lease is still running, so it cannot be set to Inactive. Inactive stops rent '
  + 'invoices and puts the unit back into availability, which is wrong while a tenant is '
  + 'in it. To end a tenancy early, use Move Out on the lease detail page — that shortens '
  + 'the lease, settles the remaining invoices, and can be undone.';

/**
 * @param {object} args
 *   requestedStatus  what the request is asking to store (any type; only 0 blocks)
 *   currentStatus    what is stored now
 *   endDate          the lease's effective end date (the request's, else the stored one)
 *   today            'YYYY-MM-DD' in the org's timezone
 * @returns {{ blocked: boolean, message?: string }}
 */
function checkTermination({ requestedStatus, currentStatus, endDate, today }) {
  // Only a transition INTO 0 is interesting. The edit form posts `status` on every
  // save, so an ordinary edit of an already-inactive lease re-sends 0 — blocking
  // that would make historical records uneditable.
  if (Number(requestedStatus) !== 0) return { blocked: false };
  if (Number(currentStatus) === 0) return { blocked: false };

  const end = toCalendarDate(endDate);
  const now = toCalendarDate(today);
  // An open-ended lease (no end date) has time left by definition. An unreadable
  // date fails CLOSED for the same reason: the cost of a wrong block is one
  // support question, the cost of a wrong allow is unbilled rent.
  if (!now) return { blocked: true, message: MESSAGE };
  if (!end) return { blocked: true, message: MESSAGE };

  // Ended yesterday or earlier → this is the archival use, allow it.
  if (end < now) return { blocked: false };
  return { blocked: true, message: MESSAGE };
}

module.exports = { checkTermination, toCalendarDate, TERMINATION_MESSAGE: MESSAGE };

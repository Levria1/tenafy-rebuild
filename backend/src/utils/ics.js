/**
 * Calendar-invite generator for viewing bookings.
 *
 * Thin wrapper around the `ics` npm package. Produces a {content, filename}
 * pair suitable for dropping into nodemailer's `attachments` array.
 *
 * Cancellations reuse the same `uid` and bump the `sequence` so mail clients
 * update the existing event instead of creating a duplicate.
 */

const ics = require('ics');

function toArray(dt) {
  // ics expects [YYYY, M, D, H, Min] in local time.
  const d = dt instanceof Date ? dt : new Date(dt);
  return [
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
  ];
}

/**
 * Build a calendar invite.
 * @param {object} opts
 * @param {string} opts.uid                Stable event UID (must match across cancellations).
 * @param {Date|string} opts.startDateTime  When the viewing starts.
 * @param {number} [opts.durationMinutes]   Length in minutes (default 30).
 * @param {string} opts.summary            Event title ("Viewing: Unit 3B @ 12 Elm St").
 * @param {string} [opts.description]
 * @param {string} [opts.location]
 * @param {object} opts.organizer          { name, email }
 * @param {Array}  opts.attendees          [{ name, email, rsvp }]
 * @param {'REQUEST'|'CANCEL'} [opts.method]  Defaults to 'REQUEST'.
 * @param {number} [opts.sequence]         Bump to 1 (or higher) for cancellations.
 * @returns {{content: Buffer, filename: string, contentType: string}}
 */
function buildViewingIcs(opts) {
  const {
    uid,
    startDateTime,
    durationMinutes = 30,
    summary,
    description,
    location,
    organizer,
    attendees = [],
    method = 'REQUEST',
    sequence = 0,
  } = opts;

  const { error, value } = ics.createEvent({
    uid,
    start: toArray(startDateTime),
    duration: { minutes: durationMinutes },
    title: summary,
    description: description || '',
    location: location || '',
    organizer,
    attendees: attendees.map(a => ({
      name: a.name,
      email: a.email,
      rsvp: a.rsvp !== false,
      partstat: method === 'CANCEL' ? 'DECLINED' : 'NEEDS-ACTION',
      role: 'REQ-PARTICIPANT',
    })),
    status: method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
    method,
    sequence,
  });

  if (error) {
    throw new Error(`Failed to build ICS: ${error.message || error}`);
  }

  return {
    filename: 'viewing.ics',
    content: Buffer.from(value, 'utf8'),
    contentType: `text/calendar; method=${method}; charset=UTF-8`,
  };
}

module.exports = { buildViewingIcs };

/**
 * Google Calendar integration for viewing bookings.
 *
 * Each staff member has their own Google Calendar (stored in user.google_calendar_id).
 * The system pushes confirmed viewings to the assigned employee's calendar, so
 * each person sees only their own bookings. They cross-subscribe (read access)
 * to each other's calendars to see the full team schedule side-by-side,
 * colour-coded by calendar.
 *
 * Auth uses a single service account (GOOGLE_SERVICE_ACCOUNT_KEY) that has
 * "Make changes to events" permission on every staff calendar.
 *
 * Gracefully skips all operations when GOOGLE_SERVICE_ACCOUNT_KEY is not
 * configured or when the target calendarId is missing.
 */

const { google } = require('googleapis');
const config = require('../config');

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!config.googleServiceAccountKey) return null;

  try {
    const credentials = typeof config.googleServiceAccountKey === 'string'
      ? JSON.parse(config.googleServiceAccountKey)
      : config.googleServiceAccountKey;

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    _client = google.calendar({ version: 'v3', auth });
    return _client;
  } catch (err) {
    console.error('[googleCalendar] init failed:', err.message);
    return null;
  }
}

/**
 * Create a viewing event on the employee's calendar.
 * Returns the Google Calendar event ID string, or null on failure/skip.
 */
async function createViewingEvent({ calendarId, booking, unit, property, employee }) {
  const cal = getClient();
  if (!cal || !calendarId) return null;

  try {
    const start = new Date(booking.proposed_datetime);
    const end = new Date(start.getTime() + (booking.duration_minutes || 30) * 60 * 1000);

    const location = [property.street_address, property.city, property.state]
      .filter(Boolean).join(', ');

    const description = [
      `Viewer:  ${booking.viewer_name}`,
      `Email:   ${booking.viewer_email}`,
      booking.viewer_phone   ? `Phone:   ${booking.viewer_phone}`   : null,
      booking.viewer_message ? `Message: ${booking.viewer_message}` : null,
      `\nHost: ${employee.name}`,
    ].filter(Boolean).join('\n');

    const event = {
      summary: `Viewing: ${unit.name} @ ${property.name}`,
      location,
      description,
      start: { dateTime: start.toISOString() },
      end:   { dateTime: end.toISOString() },
    };

    const res = await cal.events.insert({
      calendarId,
      resource: event,
      sendUpdates: 'none',
    });

    return res.data.id || null;
  } catch (err) {
    console.error('[googleCalendar] createViewingEvent failed:', err.message);
    return null;
  }
}

/**
 * Delete a viewing event from the employee's calendar.
 * Safe to call even if the event was already deleted (410 is swallowed).
 */
async function deleteViewingEvent({ calendarId, gcalEventId }) {
  const cal = getClient();
  if (!cal || !calendarId || !gcalEventId) return;

  try {
    await cal.events.delete({
      calendarId,
      eventId: gcalEventId,
      sendUpdates: 'none',
    });
  } catch (err) {
    if (err.code !== 410 && err.status !== 410) {
      console.error('[googleCalendar] deleteViewingEvent failed:', err.message);
    }
  }
}

/**
 * Query a calendar's busy intervals between timeMin and timeMax (ISO strings).
 * Used to check whether the assigned staff member is actually free before
 * offering a viewing slot.
 *
 * Returns an array of { start: Date, end: Date } busy windows.
 * Returns [] (treated as "no calendar info → don't block") when Google isn't
 * configured, the calendarId is missing, or the query fails — so callers
 * gracefully fall back to the Tenafy-only conflict check.
 */
async function getFreeBusy({ calendarId, timeMin, timeMax }) {
  const cal = getClient();
  if (!cal || !calendarId) return [];

  try {
    const res = await cal.freebusy.query({
      resource: {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        items: [{ id: calendarId }],
      },
    });
    const cals = res.data.calendars || {};
    const entry = cals[calendarId] || Object.values(cals)[0] || {};
    if (entry.errors && entry.errors.length) {
      console.error(`[googleCalendar] freebusy errors for ${calendarId}:`, JSON.stringify(entry.errors));
      return [];
    }
    return (entry.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.error('[googleCalendar] getFreeBusy failed:', err.message);
    return [];
  }
}

module.exports = { createViewingEvent, deleteViewingEvent, getFreeBusy };

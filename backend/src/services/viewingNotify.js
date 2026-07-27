/**
 * Shared viewing-email sender.
 *
 * Used by both the public viewing surface (viewingPublic.js) and the staff
 * viewing routes (viewing.js) so cancel / reschedule / confirmation emails all
 * go through one template-or-fallback path.
 *
 * If a template of the given `templateType` exists in the org's email_template
 * table, its subject + body are used (variables substituted). Otherwise the
 * provided `fallback` { subject, html } is used. Sends via the org's default
 * SMTP account when configured, else the env-based sendMail.
 *
 * Returns a Promise — caller should .catch() for fire-and-forget.
 */

const { sendMail, sendMailWithAccount } = require('../config/mailer');
const {
  findSmtpAccount,
  loadTemplate,
  substituteVariables,
  wrapEmailHtml,
} = require('./emailService');
const { createViewingEvent } = require('./googleCalendar');
const { buildViewingIcs } = require('../utils/ics');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatWhen(dt) {
  try {
    return new Date(dt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return String(dt); }
}
function employeeDisplayName(row) {
  return [row.employee_first_name, row.employee_last_name].filter(Boolean).join(' ') || row.employee_email;
}
function tenantDisplayName(row) {
  return [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ')
      || row.company_name || row.tenant_email;
}

async function sendViewingMail(pool, orgId, { templateType, variables, fallback, mailOpts }) {
  let subject = fallback.subject;
  let html    = fallback.html;

  if (templateType) {
    try {
      const template = await loadTemplate(pool, orgId, templateType);
      if (template && template.template_content) {
        subject = substituteVariables(template.subject || subject, variables || {});
        let body = substituteVariables(template.template_content, variables || {});
        // If the stored body is plain text, convert newlines to <br>
        if (!/<[a-z][\s\S]*>/i.test(body)) body = body.replace(/\n/g, '<br>\n');
        html = wrapEmailHtml(body);
        if (template.from && !mailOpts.from) mailOpts.from = template.from;
      }
    } catch (e) {
      console.error(`[viewingNotify] template load failed (${templateType}):`, e.message);
    }
  }

  const finalOpts = { ...mailOpts, subject, html };
  const smtpAccount = await findSmtpAccount(pool, orgId, finalOpts.from);
  if (smtpAccount) {
    return sendMailWithAccount(smtpAccount, finalOpts);
  }
  return sendMail(finalOpts);
}

/**
 * Send the full "viewing confirmed" fan-out for a booking that is ALREADY agreed
 * (Google Calendar event + .ics + confirmation email to viewer, host, and tenant).
 *
 * Mirrors the confirmation path in viewingPublic.js but lives here so the relay
 * scheduler (services/viewingNegotiation.js) can confirm without the tenant
 * tap-to-confirm step. `full` is a joined viewing_booking row with unit/property/
 * employee/tenant fields (see the SELECT in viewingNegotiation.confirmNegotiation).
 * Fire-and-forget: the calendar + each email .catch() their own errors.
 */
function sendViewingConfirmation(pool, orgId, full) {
  createViewingEvent({
    calendarId: full.employee_google_calendar_id,
    booking: {
      proposed_datetime: full.proposed_datetime,
      duration_minutes: full.duration_minutes,
      viewer_name: full.viewer_name,
      viewer_email: full.viewer_email,
      viewer_phone: full.viewer_phone,
      viewer_message: full.viewer_message,
    },
    unit: { name: full.unit_name },
    property: {
      name: full.property_name, street_address: full.street_address,
      city: full.city, state: full.state,
    },
    employee: { name: employeeDisplayName(full), email: full.employee_email },
  }).then(gcalEventId => {
    if (gcalEventId) {
      pool.execute('UPDATE viewing_booking SET gcal_event_id = ? WHERE id = ?', [gcalEventId, full.id])
        .catch(e => console.error('[viewingNotify] save gcal_event_id failed:', e.message));
    }
  }).catch(e => console.error('[viewingNotify] Google Calendar create failed:', e.message));

  const attendees = [
    { name: full.viewer_name, email: full.viewer_email },
    { name: employeeDisplayName(full), email: full.employee_email },
  ];
  if (full.tenant_id && full.tenant_email) {
    attendees.push({ name: tenantDisplayName(full), email: full.tenant_email });
  }

  let ics;
  try {
    ics = buildViewingIcs({
      uid: full.ics_uid,
      startDateTime: full.proposed_datetime,
      durationMinutes: full.duration_minutes,
      summary: `Viewing: ${full.unit_name} @ ${full.property_name}`,
      description: `Viewing request from ${full.viewer_name || 'prospect'}`,
      location: [full.street_address, full.city, full.state].filter(Boolean).join(', '),
      organizer: { name: employeeDisplayName(full), email: full.employee_email },
      attendees,
      method: 'REQUEST',
      sequence: 0,
    });
  } catch (e) {
    console.error('[viewingNotify] ICS build failed:', e.message);
  }

  const confirmVars = {
    '%Viewer Name%':    full.viewer_name || '',
    '%Viewer Email%':   full.viewer_email || '',
    '%Viewer Phone%':   full.viewer_phone || '',
    '%Viewing Date%':   formatWhen(full.proposed_datetime),
    '%Unit Name%':      full.unit_name || '',
    '%Property Name%':  full.property_name || '',
    '%Property Address%': [full.street_address, full.city, full.state].filter(Boolean).join(', '),
    '%Host Name%':      employeeDisplayName(full),
  };
  const fallbackHtml = `
    <p>Great news — the viewing is confirmed.</p>
    <p><strong>Unit:</strong> ${escapeHtml(full.unit_name)} &middot; ${escapeHtml(full.property_name)}<br>
       <strong>When:</strong> ${escapeHtml(formatWhen(full.proposed_datetime))}<br>
       <strong>Viewer:</strong> ${escapeHtml(full.viewer_name)}<br>
       <strong>Coordinator:</strong> ${escapeHtml(employeeDisplayName(full))}</p>
    <p>A calendar invite is attached.</p>`;
  const recipients = [full.viewer_email, full.employee_email]
    .concat(full.tenant_email ? [full.tenant_email] : [])
    .filter(Boolean);
  for (const to of recipients) {
    sendViewingMail(pool, orgId, {
      templateType: 'Viewing-Confirmation',
      variables: confirmVars,
      fallback: {
        subject: `Viewing confirmed: ${full.unit_name} — ${formatWhen(full.proposed_datetime)}`,
        html: fallbackHtml,
      },
      mailOpts: { to, attachments: ics ? [ics] : undefined },
    }).catch(e => console.error('[viewingNotify] confirmation email failed:', e.message));
  }
}

module.exports = { sendViewingMail, sendViewingConfirmation };

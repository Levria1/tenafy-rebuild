/**
 * Viewing availability request.
 *
 * Sent to the CURRENT tenant when staff tick "Request viewings" on a lease whose
 * Tenant Status is Not Renewing (NR). Asks the tenant to share their preferred
 * viewing windows so the unit can be marketed during their remaining stay.
 *
 * Channel: email + WhatsApp (via TaneChat). Uses the editable
 * `Viewing-Availability-Request` template if the org created one (Settings →
 * Email / WhatsApp Templates); otherwise falls back to built-in default copy so
 * it always works out of the box. Fire-and-forget — never throws into the
 * request path.
 */

const { sendMail } = require('../config/mailer');
const { sendTemplateEmail, loadTemplate } = require('./emailService');
const { sendWhatsApp } = require('./whatsappService');

function tenantDisplayName(row) {
  if (Number(row.type) === 1 && row.company_name) return row.company_name.trim();
  return [row.first_name, row.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || 'there';
}

// Built-in default (spec Message Template #1). Used only when the org has no
// custom Viewing-Availability-Request template.
function fallbackText(name) {
  return (
    `Hi ${name},\n\n` +
    `Thank you for choosing Tane Residence as your home during your stay in Hong Kong.\n\n` +
    `As your tenancy is approaching its end, we will soon begin marketing the unit to prospective tenants. ` +
    `As part of this process, we may need to arrange occasional viewings.\n\n` +
    `Please rest assured that a member of our staff will accompany all prospective tenants during each viewing, ` +
    `secure the unit afterward, and keep each visit brief and minimally disruptive.\n\n` +
    `To make this as convenient as possible, could you please let us know your preferred viewing times on ` +
    `weekdays and Saturdays? We will schedule viewings only within the windows you provide whenever possible.\n\n` +
    `Thank you very much for your cooperation and understanding.\n\n` +
    `Kind regards,\nTane Residence Management`
  );
}

async function sendViewingAvailabilityRequest(pool, orgId, leaseId) {
  // Resolve the current tenant + their email/phone.
  const [[row]] = await pool.execute(
    `SELECT t.first_name, t.last_name, t.company_name, t.type, t.email, t.phone
       FROM leasing l
       JOIN tenant t ON l.tenant_id = t.id
      WHERE l.id = ? LIMIT 1`,
    [leaseId]
  );
  if (!row) return;
  const name = tenantDisplayName(row);

  // Preferred path: the editable template (sends email AND WhatsApp via the hook,
  // resolving recipient from the lease).
  let tpl = null;
  try { tpl = await loadTemplate(pool, orgId, 'Viewing-Availability-Request'); } catch (_) {}
  if (tpl) {
    try {
      const sent = await sendTemplateEmail(pool, orgId, {
        templateType: 'Viewing-Availability-Request',
        leaseId,
      });
      if (sent) return; // template handled both channels
    } catch (e) {
      console.error('[viewingRequest] template send failed, using fallback:', e.message);
    }
  }

  // Fallback: built-in copy on both channels.
  const subject = 'Upcoming Viewings for Your Unit';
  const text = fallbackText(name);
  if (row.email) {
    sendMail({
      to: row.email,
      subject,
      html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
    }).catch(err => console.error('[viewingRequest] fallback email failed:', err.message));
  }
  if (row.phone) {
    sendWhatsApp(pool, orgId, row.phone, text)
      .catch(err => console.error('[viewingRequest] fallback whatsapp failed:', err.message));
  }
}

module.exports = { sendViewingAvailabilityRequest };

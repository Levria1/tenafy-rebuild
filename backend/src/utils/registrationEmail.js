/**
 * The tenant portal registration email.
 *
 * Its own module because it is the first thing ~1,846 tenants will ever see from this
 * system, and because it is the one email that must survive a sceptical read: it arrives
 * unprompted, it carries a link, and it asks the reader to set a password. Everything
 * below is shaped by that. It says who it is from, what the portal is for, exactly how
 * long the link lasts, and what to do if they did not ask for it.
 *
 * `brand` is the organisation's own display name, passed in. Nothing here may name one
 * customer: three organisations share this deployment.
 */

const { TOKEN_TTL_LABEL } = require('./tenantPortalRegistration');

// The portal's actual features, in the order a tenant cares about them. Kept honest on
// purpose: promising anything not built teaches people the emails are not accurate.
const WHAT_YOU_CAN_DO = [
  'View your tenancy details, including start and end dates',
  'View your invoices and payment history',
  'Report a repair, attach photographs, and follow its progress',
  'Keep your contact details up to date',
];

const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * @param {object} args
 * @param {string} args.brand  the organisation's display name
 * @param {string} args.link   the one-time set-password URL
 * @returns {{subject: string, text: string, html: string}}
 */
function registrationEmail({ brand, link }) {
  const org = String(brand || '').trim() || 'Your property manager';
  const subject = `${org}: Set up your tenant portal password on Tenafy`;

  const text = [
    `Dear Tenant,`,
    ``,
    `${org} uses Tenafy to manage its tenancies. Your tenant portal account is ready, and this email is the last step: choosing your password.`,
    ``,
    `Set your password here:`,
    link,
    ``,
    `This link expires in ${TOKEN_TTL_LABEL} and can only be used once. If it expires, you can request another from the sign-in page.`,
    ``,
    `Once you are signed in you will be able to:`,
    ...WHAT_YOU_CAN_DO.map((item) => `  - ${item}`),
    ``,
    `If you did not request this, no action is needed. Your account cannot be used until a password is set, and this link will stop working shortly.`,
    ``,
    `This message was sent from an address that is not monitored. Please contact ${org} directly if you have any questions.`,
    ``,
    `Kind regards,`,
    org,
  ].join('\n');

  // Inline styles only, and a table-free layout: this has to survive Gmail, Outlook and
  // a phone. A plain-text alternative always accompanies it.
  const safeOrg = escapeHtml(org);
  const safeLink = escapeHtml(link);
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#262626;max-width:560px;">
  <p style="margin:0 0 16px;">Dear Tenant,</p>

  <p style="margin:0 0 16px;">
    ${safeOrg} uses Tenafy to manage its tenancies. Your tenant portal account is ready,
    and this email is the last step: choosing your password.
  </p>

  <p style="margin:0 0 24px;">
    <a href="${safeLink}"
       style="display:inline-block;background:#1677ff;color:#ffffff;text-decoration:none;
              padding:12px 22px;border-radius:4px;font-weight:600;">Set my password</a>
  </p>

  <p style="margin:0 0 24px;color:#595959;font-size:13px;">
    This link expires in ${TOKEN_TTL_LABEL} and can only be used once.
    If it expires, you can request another from the sign-in page.
  </p>

  <p style="margin:0 0 8px;">Once you are signed in you will be able to:</p>
  <ul style="margin:0 0 24px;padding-left:20px;">
    ${WHAT_YOU_CAN_DO.map((item) => `<li style="margin-bottom:6px;">${escapeHtml(item)}</li>`).join('\n    ')}
  </ul>

  <p style="margin:0 0 24px;color:#595959;font-size:13px;">
    If you did not request this, no action is needed. Your account cannot be used until a
    password is set, and this link will stop working shortly.
  </p>

  <p style="margin:0 0 4px;color:#8c8c8c;font-size:12px;">
    This message was sent from an address that is not monitored.
    Please contact ${safeOrg} directly if you have any questions.
  </p>

  <p style="margin:24px 0 0;">Kind regards,<br>${safeOrg}</p>
</div>`.trim();

  return { subject, text, html };
}

module.exports = { registrationEmail, WHAT_YOU_CAN_DO };

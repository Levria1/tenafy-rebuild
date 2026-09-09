/**
 * Issue a tenant-portal sign-up invitation.
 *
 * WHY THIS IS SHARED
 * ------------------
 * Three places now start the same journey: a tenant registering themselves, the
 * Invite button on the Tenants list, and confirming a lease. They must produce
 * the same token, the same link and the same email, or a tenant invited by one
 * route ends up with a different experience from a tenant invited by another,
 * and a security fix applied to one quietly misses the others.
 *
 * WHY IT PREPARES RATHER THAN SENDS
 * ---------------------------------
 * The two callers need OPPOSITE behaviour on the way out, and that difference is
 * deliberate rather than accidental:
 *
 *   - Self-service registration must not become an oracle. "No such tenant",
 *     "already registered" and "email sent" are indistinguishable from outside,
 *     and the send is not awaited so that timing does not give the answer away
 *     either.
 *   - A staff invite is the opposite. Someone clicked a button and deserves to
 *     be told plainly that the tenant has no email address on file, or that the
 *     message went.
 *
 * So this returns the message to send, and the caller decides how loudly to
 * behave. The token work, the link and the wording live here once.
 */

const {
  TOKEN_TTL_MINUTES, TOKEN_TTL_LABEL, createRegistrationToken, normaliseEmail,
} = require('./tenantPortalRegistration');
const { isEligibleToRegister } = require('./tenantPortalAccess');
const { registrationEmail } = require('./registrationEmail');
const { accountSender } = require('../config/mailer');
const config = require('../config');

// Required lazily. emailService pulls in a good deal of the mail stack, and this
// module is required by three routes.
const templateApi = () => require('../services/emailService');

const TEMPLATE_TYPE = 'Portal-Invite-Tenant';

// Strip tags for the plain-text alternative. Crude on purpose: the built-in email
// carries a hand-written text part, and a customised template only has a body, so
// something readable beats nothing.
function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li\s*>/gi, '  - ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render the org's customised invitation, or return null to use the built-in one.
 *
 * Returns null rather than throwing on ANY doubt. This email is how a tenant gets
 * into the portal at all; a template that is missing, inactive, empty, or has lost
 * the sign-up link must not stop the invitation going out.
 */
async function renderFromTemplate({ pool, orgId, orgName, link, tenantName }) {
  const { loadTemplate, substituteVariables } = templateApi();
  let template = null;
  try {
    template = await loadTemplate(pool, orgId, TEMPLATE_TYPE);
  } catch (err) {
    console.error('[portal-invite] template load failed, using the built-in email:', err.message);
    return null;
  }
  if (!template || !template.template_content) return null;

  const vars = {
    '%Portal Signup Link%': link,
    // Both offered. A template written before the lifetime went from 60 minutes to
    // 7 days may still use the numeric one, and "expires in 10080 minutes" reads as
    // a bug, so %Link Expiry% is the one the seeded copy uses.
    '%Link Expiry%': TOKEN_TTL_LABEL,
    '%Link Expiry Minutes%': String(TOKEN_TTL_MINUTES),
    '%Company Name%': orgName || '',
    '%Name - Lease%': tenantName || 'Tenant',
  };

  const subject = substituteVariables(template.subject || '', vars).trim();
  const html = substituteVariables(template.template_content, vars, true);

  // The one thing a customised template cannot be allowed to drop. Someone editing
  // in a rich-text box can easily delete the variable, and the result would be a
  // polite email that gives the reader no way in.
  if (!html || !html.includes(link)) {
    console.error(`[portal-invite] template ${template.id} does not include %Portal Signup Link%; using the built-in email instead`);
    return null;
  }
  if (!subject) {
    console.error(`[portal-invite] template ${template.id} has an empty subject; using the built-in email instead`);
    return null;
  }

  return { subject, html, text: htmlToText(html) };
}

const newId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// Why each refusal exists, in words a staff user can act on.
const REASONS = {
  no_email: 'This contact has no email address on file.',
  not_eligible: 'The portal is for tenants on a lease. This contact is a payee, has no lease, or their email does not match a tenant record.',
  failed: 'Could not prepare the invitation.',
};

/**
 * @returns {Promise<{ok: true, email: string, message: object} | {ok: false, reason: string, detail: string}>}
 */
async function prepareInvite({ pool, orgId, orgName, email, tenantName }) {
  const address = normaliseEmail(email);
  if (!address) return { ok: false, reason: 'no_email', detail: REASONS.no_email };

  // The same rule self-service registration applies: a tenant (not a payee) who
  // is on a lease. Skipping it here would let the Invite button hand portal
  // access to a contractor or a prospect.
  if (!(await isEligibleToRegister(pool, orgId, address))) {
    return { ok: false, reason: 'not_eligible', detail: REASONS.not_eligible };
  }

  const { token, secretHash } = createRegistrationToken(orgId);
  const expires = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  // Update-then-insert, NOT `INSERT ... ON DUPLICATE KEY UPDATE`. ODKU fires on ANY
  // unique clash including the PRIMARY KEY, and two Snowflakes generated in the same
  // millisecond collide with probability 1e-6. On such a collision ODKU would write
  // this invitation's token onto SOMEONE ELSE'S account row, and the link would then
  // set that stranger's password.
  const [upd] = await pool.execute(
    `UPDATE tenant_portal_account
        SET verify_token_hash = ?, verify_expires_at = ?
      WHERE org_id = ? AND email = ?`,
    [secretHash, expires, orgId, address]
  );
  if (upd.affectedRows === 0) {
    try {
      await pool.execute(
        `INSERT INTO tenant_portal_account (id, org_id, email, status, verify_token_hash, verify_expires_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [newId(), orgId, address, secretHash, expires]
      );
    } catch (insertErr) {
      // Another request created the row between the UPDATE and the INSERT. The unique
      // key on (org_id, email) caught it; apply the token to that row instead.
      if (insertErr.code !== 'ER_DUP_ENTRY') throw insertErr;
      await pool.execute(
        `UPDATE tenant_portal_account SET verify_token_hash = ?, verify_expires_at = ?
          WHERE org_id = ? AND email = ?`,
        [secretHash, expires, orgId, address]
      );
    }
  }

  const link = `${config.appUrl}/tenant-portal/set-password?token=${encodeURIComponent(token)}`;

  // The org's own wording if they have written one in Settings > Email Templates,
  // otherwise the built-in. The org's own name either way, from master: three orgs
  // share this codebase and hardcoding one customer's name would sign every other
  // customer's email as them.
  const customised = await renderFromTemplate({ pool, orgId, orgName, link, tenantName });
  const { subject, text, html } = customised || registrationEmail({ brand: orgName, link });

  return {
    ok: true,
    email: address,
    message: { to: address, from: accountSender(), subject, text, html },
  };
}

module.exports = { prepareInvite, REASONS, TEMPLATE_TYPE, htmlToText };

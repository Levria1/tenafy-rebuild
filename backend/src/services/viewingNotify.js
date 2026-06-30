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

module.exports = { sendViewingMail };

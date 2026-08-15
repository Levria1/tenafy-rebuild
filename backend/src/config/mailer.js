const nodemailer = require('nodemailer');
const { sendWithRetry } = require('../utils/mailRetry');

/**
 * Creates a Nodemailer transporter from env variables.
 * Supports SMTP (any provider) or falls back to Ethereal (test) if no credentials set.
 *
 * Required env vars for production:
 *   EMAIL_HOST      - SMTP host (e.g. smtp.mailgun.org, smtp.sendgrid.net, smtp.gmail.com)
 *   EMAIL_PORT      - SMTP port (587 for TLS, 465 for SSL)
 *   EMAIL_SECURE    - 'true' for port 465, 'false' for 587
 *   EMAIL_USER      - SMTP username / API key
 *   EMAIL_PASS      - SMTP password / API secret
 *   EMAIL_FROM      - Sender address (e.g. "Tenafy <no-reply@tenafy.com>")
 */

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    // Production SMTP
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  } else {
    // Development: use Ethereal test account (prints preview URL to console)
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    console.log('[Mailer] Using Ethereal test account:', testAccount.user);
  }

  return transporter;
}

/**
 * Send an email.
 * @param {object} options - { to, subject, html, text, from, cc, bcc, replyTo }
 */
async function sendMail({ to, subject, html, text, from, cc, bcc, replyTo, attachments }) {
  const transport = await getTransporter();
  const fromAddress = from || process.env.EMAIL_FROM || 'Tenafy <no-reply@tenafy.com>';

  const mailOptions = {
    from: fromAddress,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html: html || text,
    text: text || '',
  };

  if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(', ') : cc;
  if (bcc) mailOptions.bcc = Array.isArray(bcc) ? bcc.join(', ') : bcc;
  if (replyTo) mailOptions.replyTo = replyTo;
  if (attachments) mailOptions.attachments = attachments;

  console.log(`[Mailer.sendMail] from=${mailOptions.from} to=${mailOptions.to} cc=${mailOptions.cc || '(none)'} bcc=${mailOptions.bcc || '(none)'}`);

  const info = await sendWithRetry(transport, mailOptions, { label: 'Mailer.sendMail' });

  console.log(`[Mailer.sendMail] sent ok messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)}`);

  // Log preview URL for Ethereal test emails
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log('[Mailer] Preview URL:', previewUrl);
  }

  return { messageId: info.messageId, previewUrl };
}

// ---------------------------------------------------------------------------
// Multi-account support: create per-account transporters (cached)
// ---------------------------------------------------------------------------

const accountTransporters = new Map();

/**
 * Send an email using a specific SMTP account (from the smtp_account table).
 * Transports are cached by email address to avoid reconnecting each time.
 * @param {object} account - { email, password, host, port, is_secure }
 * @param {object} options - { to, subject, html, text, from, cc, bcc, replyTo }
 */
async function sendMailWithAccount(account, { to, subject, html, text, from, cc, bcc, replyTo, attachments }) {
  const cacheKey = account.email;

  if (!accountTransporters.has(cacheKey)) {
    const isSecure = Buffer.isBuffer(account.is_secure)
      ? account.is_secure[0] === 1
      : account.is_secure !== false && account.is_secure !== 0;

    const transport = nodemailer.createTransport({
      host: account.host || 'smtp.titan.email',
      port: parseInt(account.port) || 465,
      secure: isSecure,
      auth: {
        user: account.email,
        pass: account.password,
      },
    });
    accountTransporters.set(cacheKey, transport);
  }

  const transport = accountTransporters.get(cacheKey);

  // Use the provided "from" or build one from the account
  const fromAddress = from || (account.display_name
    ? `${account.display_name} <${account.email}>`
    : account.email);

  const mailOptions = {
    from: fromAddress,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html: html || text,
    text: text || '',
  };

  if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(', ') : cc;
  if (bcc) mailOptions.bcc = Array.isArray(bcc) ? bcc.join(', ') : bcc;
  if (replyTo) mailOptions.replyTo = replyTo;
  if (attachments) mailOptions.attachments = attachments;

  console.log(`[Mailer.sendMailWithAccount] account=${account.email} from=${mailOptions.from} to=${mailOptions.to} cc=${mailOptions.cc || '(none)'} bcc=${mailOptions.bcc || '(none)'}`);

  const info = await sendWithRetry(transport, mailOptions, { label: 'Mailer.sendMailWithAccount' });

  console.log(`[Mailer.sendMailWithAccount] sent ok messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)}`);

  return { messageId: info.messageId };
}

module.exports = { sendMail, sendMailWithAccount };

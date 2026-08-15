// Retry policy for SMTP sends.
//
// Why this exists: a send that threw used to be logged to email_log with
// status='failed' and then dropped — nothing read that row, nothing retried it.
// Production accumulated 77 failures, 63 of them "Connection timeout", across
// Invoice-Tenant / Overdue-Tenant / Renewal-Tenant / Checkin-Tenant. Those are
// transient; the invoice row still exists as Open, so a tenant who never received
// the bill later gets chased as Overdue.
//
// Lives here rather than in emailService because ~20 call sites reach SMTP through
// config/mailer.js (invoice, contact, auth, signature, chatTools, viewingNotify,
// scheduler, emailTemplate, viewingPublic, viewingRequest). Wrapping the transport
// covers all of them at once.

// nodemailer sets `code` on connection failures — a connect timeout surfaces as
// ETIMEDOUT (smtp-connection calls _onConnectionError('Connection timeout',
// 'ETIMEDOUT') and _formatError copies it onto err.code).
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNECTION', 'ECONNRESET', 'ECONNREFUSED',
  'ESOCKET', 'EDNS', 'ETLS', 'EPROTOCOL', 'EPIPE', 'EAI_AGAIN',
]);

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];   // between attempt 1→2 and 2→3

// A 5xx is the server refusing this message: a bad sender (553), a dead mailbox
// (550), or rejected auth. Retrying cannot change the answer and repeated attempts
// look like abuse to the relay. 4xx is "try again later" and IS retried.
function isTransient(err) {
  if (!err) return false;
  if (err.code === 'EAUTH') return false;
  const rc = Number(err.responseCode);
  if (Number.isFinite(rc) && rc >= 500 && rc < 600) return false;
  if (Number.isFinite(rc) && rc >= 400 && rc < 500) return true;
  if (TRANSIENT_CODES.has(err.code)) return true;
  // No code and no response code — a socket that died mid-flight. Treat as
  // transient; attempts are bounded, so the cost of guessing wrong is one retry.
  if (!err.code && !Number.isFinite(rc)) return true;
  return /timeout|timed out|socket|connection/i.test(err.message || '');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Send through `transport`, retrying transient failures.
 *
 * Rethrows the LAST error after the final attempt, with `.attempts` attached so
 * the caller can record "failed 3 times" separately from "failed once" — the two
 * mean very different things when reading email_log.
 *
 * @param {object} transport  nodemailer transport
 * @param {object} mailOptions
 * @param {object} [opts]     { label, maxAttempts, backoffMs, wait } — `wait` is
 *                            injectable so tests do not actually sleep.
 */
async function sendWithRetry(transport, mailOptions, opts = {}) {
  const label = opts.label || 'Mailer';
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const backoff = opts.backoffMs || BACKOFF_MS;
  const wait = opts.wait || sleep;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await transport.sendMail(mailOptions);
      if (attempt > 1) {
        console.log(`[${label}] recovered on attempt ${attempt}/${maxAttempts} to=${mailOptions.to}`);
      }
      return info;
    } catch (err) {
      lastErr = err;
      const transient = isTransient(err);
      const last = attempt === maxAttempts;
      if (!transient || last) {
        err.attempts = attempt;
        if (!transient) {
          console.error(`[${label}] permanent failure (${err.code || err.responseCode || 'no code'}) to=${mailOptions.to}: ${err.message}`);
        } else {
          console.error(`[${label}] gave up after ${attempt} attempts to=${mailOptions.to}: ${err.message}`);
        }
        throw err;
      }
      const delay = backoff[attempt - 1] != null ? backoff[attempt - 1] : backoff[backoff.length - 1];
      console.warn(`[${label}] attempt ${attempt}/${maxAttempts} failed (${err.code || 'no code'}): ${err.message} — retrying in ${delay}ms`);
      await wait(delay);
    }
  }
  throw lastErr;   // unreachable; keeps the contract explicit
}

module.exports = { sendWithRetry, isTransient, MAX_ATTEMPTS, BACKOFF_MS };

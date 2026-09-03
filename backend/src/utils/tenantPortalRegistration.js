/**
 * Registration tokens for the tenant portal.
 *
 * The emailed token has to survive a problem the staff flow does not have: at the moment
 * someone clicks the link there is no session, so nothing tells us WHICH org's database
 * holds their pending registration. The token therefore carries the org itself:
 *
 *     <base64url(orgId)>.<64 hex chars of randomness>
 *
 * Only the random half is secret, and only its sha256 is stored, so a dump of
 * `tenant_portal_account` does not let anyone complete a pending registration. The org id
 * is not a secret; it appears in staff URLs throughout the app.
 *
 * The alternative was a master-level token index. This avoids a second table whose rows
 * would need expiring, and keeps the token self-describing.
 */

const crypto = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MINUTES = 60;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Returns { token, secretHash } — email `token`, store `secretHash`. */
function createRegistrationToken(orgId) {
  if (!orgId) throw new Error('a registration token must name an org');
  const secret = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const orgPart = Buffer.from(String(orgId), 'utf8').toString('base64url');
  return { token: `${orgPart}.${secret}`, secretHash: sha256(secret) };
}

/**
 * Split a submitted token. Returns { orgId, secretHash } or null.
 *
 * Never throws on malformed input: this is fed straight from a query string, so garbage
 * is the normal case and must produce the same bland failure as a wrong-but-well-formed
 * token rather than a stack trace or a distinguishable error.
 */
function parseRegistrationToken(token) {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  const orgPart = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(secret)) return null;
  let orgId;
  try {
    orgId = Buffer.from(orgPart, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  if (!/^\d{1,20}$/.test(orgId)) return null;
  return { orgId, secretHash: sha256(secret) };
}

/**
 * Password rules, kept blunt on purpose.
 *
 * A length floor with no composition rules is what current guidance actually supports,
 * and the people typing these are tenants on a phone, not staff who can be trained.
 * Anything that pushes them toward "Summer2026!" is worse than a long simple passphrase.
 */
const MIN_PASSWORD_LENGTH = 10;

function passwordProblem(password) {
  if (typeof password !== 'string') return 'Choose a password.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return 'Password must be 200 characters or fewer.';
  return null;
}

// Deliberately permissive: this decides who gets an email, not who is a real person, and
// a regex that rejects a valid address locks a tenant out of their own portal.
function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const e = value.trim().toLowerCase();
  if (e.length < 3 || e.length > 255) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

module.exports = {
  TOKEN_TTL_MINUTES,
  MIN_PASSWORD_LENGTH,
  sha256,
  createRegistrationToken,
  parseRegistrationToken,
  passwordProblem,
  normaliseEmail,
};

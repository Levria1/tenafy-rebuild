/**
 * Tenant portal tokens — kept deliberately separate from staff tokens.
 *
 * The portal used to mint a JWT with `role: 'tenant'` into the SAME `__s_t` cookie,
 * signed with the SAME secret as staff. `middleware/auth.js` verifies the signature and
 * never reads `role`, and no route in the app calls `authorize()` with a role list, so
 * 412 staff endpoints would have accepted that token. A tenant login was a staff login.
 *
 * The fix is not another conditional. It is a different secret and a different cookie, so
 * a tenant token presented to a staff route fails at SIGNATURE VERIFICATION. That property
 * holds even if someone later adds a route and forgets every guard, which is the only kind
 * of guarantee worth having across 412 endpoints.
 *
 * Everything here is pure so the boundary can be tested without a database or an app.
 */

const jwt = require('jsonwebtoken');

const TENANT_COOKIE = '__t_p';   // staff use __s_t; the names must never converge
const TENANT_ROLE = 'tenant';

/**
 * Is the tenant secret usable? Returns the secret, or null with a reason.
 *
 * A missing secret must not fall back to the staff secret or to a literal default: both
 * would silently rebuild the hole this module exists to close. Equally, it must not throw
 * at import time — the backend serves staff on 412 routes, and a deploy that forgot one
 * env var should disable the tenant portal, not take the business offline. So this fails
 * CLOSED at the portal boundary and leaves everything else running.
 */
function resolveTenantSecret({ tenantSecret, staffSecret } = {}) {
  const t = typeof tenantSecret === 'string' ? tenantSecret.trim() : '';
  if (!t) return { secret: null, reason: 'TENANT_JWT_SECRET is not set' };
  if (t.length < 32) return { secret: null, reason: 'TENANT_JWT_SECRET is too short (needs 32+ chars)' };
  if (typeof staffSecret === 'string' && t === staffSecret.trim()) {
    // Same secret means a tenant token verifies against staff routes. That is the
    // original bug wearing a different variable name.
    return { secret: null, reason: 'TENANT_JWT_SECRET must differ from JWT_SECRET' };
  }
  return { secret: t, reason: null };
}

function signTenantToken({ email, orgId, tokenVersion = 0 }, secret, { expiresIn = '2h' } = {}) {
  if (!secret) throw new Error('refusing to sign a tenant token without a dedicated secret');
  if (!email || !orgId) throw new Error('tenant token needs an email and an orgId');
  // Note what is NOT in here: no userId, no permissions, no isMasterAdmin. There is no
  // staff identity to escalate to because the token never carried one.
  // Algorithm pinned on both sides so a token cannot arrive claiming a different one.
  // `v` is the account's session generation. Changing a password bumps it, which makes
  // every token issued before the change fail the comparison in authenticateTenant. A
  // reset prompted by a stolen cookie has to end that cookie, not outlive it.
  return jwt.sign(
    { email: String(email).toLowerCase(), orgId: String(orgId), role: TENANT_ROLE, v: Number(tokenVersion) || 0 },
    secret, { expiresIn, algorithm: 'HS256' });
}

/**
 * Verify and shape a tenant token. Returns { payload } or { error }.
 *
 * Requires role === 'tenant' as well as a valid signature. Belt and braces: the separate
 * secret already makes a staff token unverifiable here, but a token minted by a future
 * bug with the right secret and the wrong role should still be refused.
 */
function verifyTenantToken(token, secret) {
  if (!secret) return { error: 'tenant portal is not configured' };
  if (!token) return { error: 'authentication required' };
  let decoded;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (e) {
    return { error: 'invalid or expired token' };
  }
  if (!decoded || decoded.role !== TENANT_ROLE) return { error: 'not a tenant token' };
  if (!decoded.email || !decoded.orgId) return { error: 'malformed tenant token' };
  return { payload: {
    email: String(decoded.email).toLowerCase(),
    orgId: String(decoded.orgId),
    role: TENANT_ROLE,
    v: Number.isInteger(decoded.v) ? decoded.v : 0,
  } };
}

module.exports = { TENANT_COOKIE, TENANT_ROLE, resolveTenantSecret, signTenantToken, verifyTenantToken };

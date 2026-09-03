/**
 * Tenant portal authentication. Used ONLY by /api/tenant-portal/*.
 *
 * Deliberately not a variant of middleware/auth.js. That one attaches a staff identity
 * (userId, permissions, master-admin bypass) and is trusted by 412 endpoints. Nothing a
 * tenant sends should ever travel through it. See utils/tenantPortalTokens.js.
 */

const config = require('../config');
const { getOrgPool } = require('../config/poolRegistry');
const { TENANT_COOKIE, resolveTenantSecret, verifyTenantToken, signTenantToken } = require('../utils/tenantPortalTokens');
const { resolveTenantIds, loadActiveAccount } = require('../utils/tenantPortalAccess');

/** Resolved once at load; a secret change needs a restart, same as the staff secret. */
const { secret: TENANT_SECRET, reason: TENANT_SECRET_REASON } = resolveTenantSecret({
  tenantSecret: config.tenantJwtSecret,
  staffSecret: config.jwtSecret,
});

if (!TENANT_SECRET) {
  // Loud, but not fatal. A deploy that forgot one env var should disable the tenant
  // portal, not take 412 staff endpoints offline with it.
  console.warn(`[tenant-portal] DISABLED: ${TENANT_SECRET_REASON}`);
}

function tenantPortalEnabled() {
  return Boolean(TENANT_SECRET);
}

const authenticateTenant = async (req, res, next) => {
  if (!TENANT_SECRET) {
    return res.status(503).json({ code: 503, message: 'Tenant portal is not configured' });
  }

  // Only the tenant cookie. Never falls back to __s_t: a staff member with an open
  // session must not be silently treated as the tenant whose portal they are looking at.
  const token = req.cookies?.[TENANT_COOKIE] || req.headers.authorization?.replace('Bearer ', '');
  const { payload, error } = verifyTenantToken(token, TENANT_SECRET);
  if (error) return res.status(401).json({ code: 401, message: 'Authentication required' });

  try {
    req.pool = await getOrgPool(payload.orgId);
  } catch (poolErr) {
    if (poolErr.message.includes('not found')) return res.status(403).json({ code: 403, message: 'Organization not found' });
    if (poolErr.message.includes('disabled')) return res.status(403).json({ code: 403, message: 'Organization is currently disabled' });
    console.error('[tenant-portal] org pool error:', poolErr);
    return res.status(500).json({ code: 500, message: 'Database connection error' });
  }

  // Everything below is re-checked on EVERY request, deliberately. A signed token proves
  // who asked, never what they may still do: an account disabled a minute ago, or a tenant
  // row deleted since login, has to take effect now rather than when the token expires.
  //
  // Wrapped because Express 4 does not catch a rejected promise from async middleware. An
  // unhandled rejection here would hang the request instead of failing it.
  let tenantIds;
  try {
    const account = await loadActiveAccount(req.pool, payload.orgId, payload.email);
    if (!account) {
      // Unverified, disabled by staff, or deleted. Same answer either way; the token
      // itself is still validly signed, which is exactly why this check cannot live at
      // login time only.
      return res.status(403).json({ code: 403, message: 'This account is not active' });
    }

    // A password change bumps token_version, so every session issued before it dies here.
    // Without this, resetting a password because someone else holds your cookie leaves
    // that cookie working until it expires.
    if (Number(payload.v || 0) !== Number(account.tokenVersion || 0)) {
      return res.status(401).json({ code: 401, message: 'Your session has ended. Please sign in again.' });
    }

    tenantIds = await resolveTenantIds(req.pool, payload.orgId, payload.email);
  } catch (err) {
    console.error('[tenant-portal] identity resolution failed:', err);
    return res.status(500).json({ code: 500, message: 'Authentication failed' });
  }

  if (tenantIds.length === 0) {
    // Verified credentials, but the tenant rows are gone or soft-deleted. Fail closed.
    return res.status(403).json({ code: 403, message: 'No tenant record is linked to this account' });
  }

  req.tenantPortal = { email: payload.email, orgId: payload.orgId, tenantIds };
  // Intentionally NOT set: req.user. Anything reading req.user is staff code, and a
  // tenant request reaching it should fail loudly rather than inherit an identity.
  next();
};

/**
 * Sign a session and set the cookie. Lives here so the tenant secret is read in exactly
 * one place; a route that needed the raw secret would be a route that could leak it into
 * the staff side by accident.
 */
function issueTenantSession(res, { email, orgId, tokenVersion = 0 }) {
  if (!TENANT_SECRET) throw new Error('tenant portal is not configured');
  const token = signTenantToken({ email, orgId, tokenVersion }, TENANT_SECRET, { expiresIn: config.tenantJwtExpiresIn });
  res.cookie(TENANT_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 2 * 60 * 60 * 1000,
  });
  // Deliberately NOT returned in the response body. The staff login does return its
  // token, which means a XSS on that page can read it; there is no reason to repeat that
  // on a surface we are opening to ~1,721 people.
  return token;
}

function clearTenantSession(res) {
  res.clearCookie(TENANT_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  });
}

module.exports = { authenticateTenant, tenantPortalEnabled, issueTenantSession, clearTenantSession, TENANT_COOKIE };

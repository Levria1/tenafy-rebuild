const jwt = require('jsonwebtoken');
const config = require('../config');
const { getOrgPool } = require('../config/poolRegistry');
const { isTokenRevoked } = require('../utils/sessionRevocation');

const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.__s_t || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }

    const decoded = jwt.verify(token, config.jwtSecret);

    // Tenant portal tokens must never authenticate a staff route. The dedicated secret
    // in utils/tenantPortalTokens.js already makes such a token fail verification above,
    // so reaching this line means either a legacy token issued before the split or a
    // future bug. Both are refused here rather than inheriting a staff identity across
    // the 412 endpoints that sit behind this middleware.
    if (decoded?.role === 'tenant') {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }

    req.user = decoded;

    // Attach org pool for non-master-admin users
    if (decoded.orgId && !decoded.isMasterAdmin) {
      try {
        req.pool = await getOrgPool(decoded.orgId);
      } catch (poolErr) {
        if (poolErr.message.includes('not found')) {
          return res.status(403).json({ code: 403, message: 'Organization not found' });
        }
        if (poolErr.message.includes('disabled')) {
          return res.status(403).json({ code: 403, message: 'Organization is currently disabled' });
        }
        console.error('Org pool error:', poolErr);
        return res.status(500).json({ code: 500, message: 'Database connection error' });
      }
      if (await isTokenRevoked(req.pool, decoded)) {
        return res.status(401).json({
          code: 401,
          message: 'Session ended because the password was changed. Please log in again.',
        });
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Invalid or expired token' });
  }
};

const isSuperAdmin = (req) => {
  // Keep the org-wide check deliberately for backward compatibility. Tokens
  // issued before per-user super admins have no isSuperAdmin field, and removing
  // this branch would de-privilege existing super-admin orgs mid-session.
  return Number(req.user?.orgType) === 6 || !!req.user?.isSuperAdmin;
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }
    // Superadmin bypasses all role checks
    if (isSuperAdmin(req)) {
      return next();
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ code: 403, message: 'Insufficient permissions' });
    }
    next();
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ code: 401, message: 'Authentication required' });
  }
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ code: 403, message: 'Superadmin access required' });
  }
  next();
};

// Load user permissions from role_permission via user_role
// Uses req.pool (set by orgPool middleware)
const loadPermissions = async (req, res, next) => {
  try {
    if (isSuperAdmin(req)) {
      req.user.permissions = ['*'];
      return next();
    }

    const [perms] = await req.pool.execute(
      `SELECT rp.permission_code
       FROM role_permission rp
       JOIN user_role ur ON rp.role_id = ur.role_id
       WHERE ur.user_id = ?`,
      [req.user.id]
    );
    req.user.permissions = perms.map(p => p.permission_code);
    next();
  } catch (error) {
    console.error('Load permissions error:', error);
    req.user.permissions = [];
    next();
  }
};

// Check if user has a specific permission
// Uses req.pool (set by orgPool middleware)
const requirePermission = (...permissions) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }
    // Superadmin bypasses all permission checks
    if (isSuperAdmin(req)) {
      return next();
    }
    // Load permissions if not already loaded
    if (!req.user.permissions) {
      const [perms] = await req.pool.execute(
        `SELECT rp.permission_code
         FROM role_permission rp
         JOIN user_role ur ON rp.role_id = ur.role_id
         WHERE ur.user_id = ?`,
        [req.user.id]
      );
      req.user.permissions = perms.map(p => p.permission_code);
    }
    if (req.user.permissions.includes('*')) {
      return next();
    }
    const hasPermission = permissions.some(p => req.user.permissions.includes(p));
    if (!hasPermission) {
      return res.status(403).json({ code: 403, message: 'Insufficient permissions' });
    }
    next();
  };
};

module.exports = { authenticate, authorize, requireSuperAdmin, loadPermissions, requirePermission, isSuperAdmin };

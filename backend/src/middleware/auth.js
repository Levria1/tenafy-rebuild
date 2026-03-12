const jwt = require('jsonwebtoken');
const config = require('../config');
const pool = require('../config/database');

const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.__s_t || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }

    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Invalid or expired token' });
  }
};

const isSuperAdmin = (req) => {
  return Number(req.user?.orgType) === 6;
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
const loadPermissions = async (req, res, next) => {
  try {
    if (isSuperAdmin(req)) {
      req.user.permissions = ['*'];
      return next();
    }

    const [perms] = await pool.execute(
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
      const [perms] = await pool.execute(
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

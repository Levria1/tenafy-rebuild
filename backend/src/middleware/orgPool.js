const { getOrgPool } = require('../config/poolRegistry');

/**
 * Middleware that resolves the org database pool from req.user.orgId
 * Must run AFTER authenticate middleware
 */
const attachOrgPool = async (req, res, next) => {
  try {
    if (!req.user || !req.user.orgId) {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }

    req.pool = await getOrgPool(req.user.orgId);
    next();
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(403).json({ code: 403, message: 'Organization not found' });
    }
    if (error.message.includes('disabled')) {
      return res.status(403).json({ code: 403, message: 'Organization is currently disabled' });
    }
    console.error('Org pool middleware error:', error);
    return res.status(500).json({ code: 500, message: 'Database connection error' });
  }
};

module.exports = { attachOrgPool };

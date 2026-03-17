const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Authenticates master admin JWT tokens.
 * Master admin tokens have isMasterAdmin: true in the payload.
 */
const authenticateMaster = (req, res, next) => {
  try {
    const token = req.cookies?.__s_t || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ code: 401, message: 'Authentication required' });
    }

    const decoded = jwt.verify(token, config.jwtSecret);

    if (!decoded.isMasterAdmin) {
      return res.status(403).json({ code: 403, message: 'Master admin access required' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Invalid or expired token' });
  }
};

module.exports = { authenticateMaster };

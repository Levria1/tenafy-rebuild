const { getMasterPool, getOrgPool } = require('../config/poolRegistry');

// POSTs that write nothing and exist only to read. The method is POST rather than
// GET so that free text — a customer's raw inbound message — travels in a body
// instead of a query string, which would put it in every access log.
//
// Membership here is a security assertion, not a convenience: a path in this set
// is reachable by every read-only key. Add one ONLY if the handler performs no
// writes of any kind, and prefer GET whenever the input is not sensitive.
const READ_ONLY_SAFE_POSTS = new Set([
  '/units/resolve',
]);

// The middleware is mounted inside the public router, so req.path is already
// relative to /api/public. Compared with the trailing slash stripped so
// "/units/resolve/" cannot slip past the set.
function isReadOnlySafePost(req) {
  if (req.method !== 'POST') return false;
  const path = String(req.path || '').replace(/\/+$/, '') || '/';
  return READ_ONLY_SAFE_POSTS.has(path);
}

/**
 * Middleware that authenticates via X-API-Key header.
 * Resolves the org pool and attaches it to req.pool.
 */
const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({ code: 401, message: 'API key required. Pass it via X-API-Key header.' });
    }

    const masterPool = getMasterPool();
    const [rows] = await masterPool.execute(
      `SELECT k.id, k.org_id, k.name, k.status, k.read_only, o.public_api_enabled
       FROM api_keys k
       JOIN organizations o ON k.org_id = o.id
       WHERE k.api_key = ?`,
      [apiKey]
    );

    if (rows.length === 0) {
      return res.status(401).json({ code: 401, message: 'Invalid API key' });
    }

    const keyRow = rows[0];

    if (Number(keyRow.public_api_enabled) !== 1) {
      return res.status(403).json({ code: 403, message: 'Public API is not enabled for this organization' });
    }

    if (Number(keyRow.status) !== 1) {
      return res.status(403).json({ code: 403, message: 'API key is disabled' });
    }

    // Resolve org pool
    try {
      req.pool = await getOrgPool(keyRow.org_id);
    } catch (poolErr) {
      if (poolErr.message.includes('not found')) {
        return res.status(403).json({ code: 403, message: 'Organization not found' });
      }
      if (poolErr.message.includes('disabled')) {
        return res.status(403).json({ code: 403, message: 'Organization is currently disabled' });
      }
      console.error('API key org pool error:', poolErr);
      return res.status(500).json({ code: 500, message: 'Database connection error' });
    }

    req.apiKey = {
      id: keyRow.id,
      orgId: keyRow.org_id,
      name: keyRow.name,
      readOnly: Number(keyRow.read_only) === 1,
    };

    // Read-only keys may only read: allow GET/HEAD/OPTIONS, reject any write.
    // The allowlist below covers the handful of POSTs that are semantically
    // reads — see READ_ONLY_SAFE_POSTS.
    if (req.apiKey.readOnly
        && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && !isReadOnlySafePost(req)) {
      return res.status(403).json({ code: 403, message: 'This API key is read-only; write operations are not permitted.' });
    }

    // Update last_used_at (fire-and-forget)
    masterPool.execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [keyRow.id]).catch(() => {});

    next();
  } catch (error) {
    console.error('API key auth error:', error);
    return res.status(500).json({ code: 500, message: 'Authentication error' });
  }
};

module.exports = { authenticateApiKey, READ_ONLY_SAFE_POSTS, isReadOnlySafePost };

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

function cacheKey(orgId, userId) {
  return `${orgId}:${userId}`;
}

function isSchemaMissingError(err) {
  return /doesn't exist|Unknown column|Unknown table/i.test(err && err.message);
}

async function getPasswordChangedAt(pool, orgId, userId) {
  const key = cacheKey(orgId, userId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const [rows] = await pool.execute(
      'SELECT UNIX_TIMESTAMP(password_changed_at) AS changed FROM user WHERE id = ? AND org_id = ?',
      [String(userId), String(orgId)]
    );
    const value = rows[0]?.changed == null ? null : Number(rows[0].changed);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    if (isSchemaMissingError(err)) {
      cache.set(key, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }
    throw err;
  }
}

function invalidatePasswordChangedAt(orgId, userId) {
  cache.delete(cacheKey(orgId, userId));
}

async function isTokenRevoked(pool, decoded) {
  if (!decoded?.iat || !decoded?.id || !decoded?.orgId) return false;
  try {
    const changed = await getPasswordChangedAt(pool, decoded.orgId, decoded.id);
    return changed !== null && Number(decoded.iat) < changed;
  } catch (err) {
    console.error('Session revocation check failed:', err);
    return false;
  }
}

function _resetCacheForTests() {
  cache.clear();
}

module.exports = {
  getPasswordChangedAt,
  invalidatePasswordChangedAt,
  isTokenRevoked,
  _resetCacheForTests,
};

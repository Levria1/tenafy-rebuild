/**
 * Activity logging utility
 * Usage: await logActivity(req, 'CREATE', 'lease', leaseId, 'Created lease LEA1234 for Unit 3A');
 */
async function logActivity(req, action, entityType, entityId, description, details = null) {
  try {
    const pool = req.pool;
    const orgId = req.user?.orgId;
    const userId = req.user?.id;
    const username = req.user?.username || null;
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || null;

    if (!pool || !orgId || !userId) return;

    await pool.execute(
      `INSERT INTO activity_log (org_id, user_id, username, action, entity_type, entity_id, description, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, userId, username, action, entityType, entityId ? String(entityId) : null, description || null, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    // Never let logging errors break the actual request
    console.error('Activity log error:', err.message);
  }
}

module.exports = { logActivity };

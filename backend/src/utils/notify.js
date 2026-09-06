/**
 * In-app notifications.
 *
 * Lifted out of services/scheduler.js so a request handler can raise one without
 * requiring the scheduler, which owns every cron job in the application. scheduler.js
 * still re-exports it, so nothing that already imported it there had to change.
 */

const newId = () =>
  (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

/**
 * Never throws. A notification is a courtesy attached to some other piece of work, and
 * failing to record one must not fail the repair request that triggered it.
 */
async function createNotification(pool, { orgId, type, title, message, link }) {
  try {
    await pool.execute(
      `INSERT INTO notification (id, org_id, type, title, message, link, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
      [newId(), orgId, type || 'info', title, message || null, link || null]
    );
  } catch (err) {
    console.error('[notify] failed to create notification:', err.message);
  }
}

module.exports = { createNotification };

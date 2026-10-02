const bcrypt = require('bcryptjs');
const { invalidatePasswordChangedAt } = require('../utils/sessionRevocation');

function isSchemaMissingError(err) {
  return /doesn't exist|Unknown column|Unknown table/i.test(err && err.message);
}

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

async function changeOwnPassword(pool, { userId, orgId }, { currentPassword, newPassword }) {
  if (typeof currentPassword !== 'string' || !currentPassword ||
      typeof newPassword !== 'string' || !newPassword) {
    return failure(400, 400, 'Current password and new password are required');
  }
  if (newPassword.length < 12 || newPassword.length > 128) {
    return failure(400, 4005, 'New password must be at least 12 characters');
  }
  if (newPassword === currentPassword) {
    return failure(400, 4006, 'New password must be different from the current one');
  }

  const [users] = await pool.execute(
    'SELECT id, password FROM user WHERE id = ? AND org_id = ?',
    [String(userId), String(orgId)]
  );
  if (!users.length) return failure(404, 404, 'User not found');

  let storedHash = users[0].password;
  if (storedHash.startsWith('{bcrypt}')) storedHash = storedHash.replace('{bcrypt}', '');
  if (storedHash.startsWith('$2a$')) storedHash = storedHash.replace('$2a$', '$2b$');
  if (!await bcrypt.compare(currentPassword, storedHash)) {
    return failure(400, 4004, 'Current password is incorrect');
  }

  const password = `{bcrypt}${await bcrypt.hash(newPassword, 10)}`;
  const changedAt = Math.floor(Date.now() / 1000);
  let persistedChangedAt = changedAt;
  try {
    await pool.execute(
      'UPDATE user SET password = ?, password_changed_at = FROM_UNIXTIME(?), updated_at = NOW() WHERE id = ? AND org_id = ?',
      [password, changedAt, String(userId), String(orgId)]
    );
  } catch (err) {
    if (!isSchemaMissingError(err)) throw err;
    await pool.execute(
      'UPDATE user SET password = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [password, String(userId), String(orgId)]
    );
    persistedChangedAt = null;
  }
  invalidatePasswordChangedAt(orgId, userId);
  return { ok: true, changedAt: persistedChangedAt };
}

async function markPasswordChanged(pool, orgId, userId) {
  const changedAt = Math.floor(Date.now() / 1000);
  try {
    await pool.execute(
      'UPDATE user SET password_changed_at = FROM_UNIXTIME(?) WHERE id = ? AND org_id = ?',
      [changedAt, String(userId), String(orgId)]
    );
  } catch (err) {
    if (!isSchemaMissingError(err)) throw err;
  }
  invalidatePasswordChangedAt(orgId, userId);
}

module.exports = { changeOwnPassword, markPasswordChanged };

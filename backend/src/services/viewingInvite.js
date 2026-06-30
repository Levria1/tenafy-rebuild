/**
 * Mint a per-prospect, prefilled, expiring viewing invite.
 *
 * Shared by:
 *   - POST /api/public/viewing-link (TaneChat mints a link for a prospect)
 *   - POST /api/viewing/bookings/:id/reschedule (staff re-issue a fresh link)
 *
 * Inserts a `viewing_invite` row and registers its token in the master
 * `viewing_link_registry` (kind = KIND_INVITE) so the public middleware can
 * resolve the org without auth. Returns { id, token, url, expires_at }.
 */

const crypto = require('crypto');
const config = require('../config');
const { getMasterPool } = require('../config/poolRegistry');
const { KIND_INVITE } = require('../middleware/viewingTokenAuth');

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

async function mintInvite(pool, orgId, {
  unitId, propertyId, employeeId = null, leasingId = null,
  prospect = {}, prefillDate = null, prefillTimes = null, ttlDays = 7,
}) {
  const token = 'vbi_' + crypto.randomBytes(24).toString('hex');
  const inviteId = newId();
  const ttl = Number(ttlDays) > 0 ? Math.floor(Number(ttlDays)) : 7;
  // prefillTimes: array of 'YYYY-MM-DDTHH:mm:ss' strings the bot already parsed.
  const prefillTimesJson = Array.isArray(prefillTimes) && prefillTimes.length
    ? JSON.stringify(prefillTimes) : null;

  await pool.execute(
    `INSERT INTO viewing_invite
       (id, token, unit_id, property_id, employee_id, leasing_id,
        prospect_name, prospect_phone, prospect_email, prefill_date, prefill_times, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), 1, NOW())`,
    [
      inviteId, token, unitId, propertyId, employeeId || null, leasingId || null,
      (prospect.name || '').trim() || null,
      (prospect.phone || '').trim() || null,
      (prospect.email || '').trim() || null,
      prefillDate, prefillTimesJson, ttl,
    ]
  );

  await getMasterPool().execute(
    `INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES (?, ?, ?, 1)`,
    [token, String(orgId), KIND_INVITE]
  );

  const base = (config.frontendUrl || '').replace(/\/$/, '');
  const [[row]] = await pool.execute('SELECT expires_at FROM viewing_invite WHERE id = ?', [inviteId]);
  return {
    id: inviteId,
    token,
    url: `${base}/book/viewing/invite/${token}`,
    expires_at: row ? row.expires_at : null,
  };
}

module.exports = { mintInvite };

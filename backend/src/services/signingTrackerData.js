const { orgTimeSql } = require('../utils/orgTime');

function clampTrackerFrom(value) {
  const earliest = '2026-09-01';
  const candidate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value : null;
  const parsed = candidate ? new Date(`${candidate}T00:00:00Z`) : null;
  const requested = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate : earliest;
  return requested >= earliest ? requested : earliest;
}

async function loadSigningTrackerInputs(pool, orgId, from) {
  const [leases] = await pool.execute(
    `SELECT l.id, l.lease_no,
            DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
            DATE_FORMAT(${orgTimeSql('l.created_at')}, '%Y-%m-%d') AS lease_created_at,
            u.name AS unit_name, p.display_name AS property_name,
            COALESCE(NULLIF(TRIM(t.company_name),''), TRIM(CONCAT(IFNULL(t.first_name,''),' ',IFNULL(t.last_name,'')))) AS tenant_name,
            bp.name AS platform_name, bp.requires_signature
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN booking_platform bp ON l.booking_platform_id = bp.id AND bp.org_id = ?
      WHERE p.org_id = ? AND l.deleted_at IS NULL
        AND (l.end_date IS NULL OR l.end_date >= ?)
      ORDER BY l.start_date DESC, u.name ASC`,
    [orgId, orgId, from]
  );

  let documents = [];
  const leaseIds = leases.map(lease => lease.id);
  try {
    for (let offset = 0; offset < leaseIds.length; offset += 500) {
      const ids = leaseIds.slice(offset, offset + 500);
      const placeholders = ids.map(() => '?').join(',');
      const [chunk] = await pool.execute(
        `SELECT id, lease_id, status, signature_method,
                DATE_FORMAT(term_start, '%Y-%m-%d') AS term_start,
                DATE_FORMAT(term_end, '%Y-%m-%d') AS term_end,
                DATE_FORMAT(${orgTimeSql('sent_at')}, '%Y-%m-%d')      AS sent_at,
                DATE_FORMAT(${orgTimeSql('completed_at')}, '%Y-%m-%d') AS completed_at,
                expires_at,
                created_at,
                (SELECT COUNT(*) FROM signature_party sp WHERE sp.request_id = signature_request.id) AS party_count,
                (SELECT COUNT(*) FROM signature_party sp WHERE sp.request_id = signature_request.id AND sp.status = 2) AS signed_count
           FROM signature_request
          WHERE org_id = ? AND lease_id IN (${placeholders})
          ORDER BY term_start IS NULL, term_start ASC, created_at ASC`,
        [orgId, ...ids]
      );
      documents.push(...chunk);
    }
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
      console.error('[leasing] signing tracker lookup skipped (un-migrated org):', error.message);
      documents = [];
    } else {
      throw error;
    }
  }

  return { leases, documents };
}

module.exports = { clampTrackerFrom, loadSigningTrackerInputs };

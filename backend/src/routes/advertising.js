const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Advertising → Vacancy
// Units that need advertising, in two categories:
//   1. VACANT NOW  — active unit that was PREVIOUSLY leased, has no current lease
//      AND no upcoming lease (a tenant left and nothing is lined up). The MOST
//      urgent. Requires a prior ended lease so never-leased/placeholder units
//      (often test data) don't pollute the list.
//   2. EXPIRING    — a current lease is ending within its renewal-intent lead
//      window and no replacement is lined up.
//
// Keyed off DATE-COMPUTED lease status (start_date/end_date/CURDATE()), NOT the
// stored `leasing.status` column — that column is not maintained on expiry.
//
// Lead windows (contract_type): NR(3)=45d, UC(4)=30d, MR/MTM/unset=20d.
// Sorted by urgency: longest-vacant first, then soonest-to-expire, then
// never-leased units last.
// ---------------------------------------------------------------------------

const LEAD_DAYS = { NR: 45, UC: 30, DEFAULT: 20 };
const LEAD_SQL = `CASE l.contract_type WHEN 3 THEN ${LEAD_DAYS.NR} WHEN 4 THEN ${LEAD_DAYS.UC} ELSE ${LEAD_DAYS.DEFAULT} END`;
const INTENT = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };

const TENANT_NAME_SQL = `CASE WHEN t.type = 1 THEN t.company_name
       ELSE TRIM(CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))) END`;

// Sub-conditions reused for the "vacant now" query (correlated on u.id).
const NO_CURRENT_LEASE = `NOT EXISTS (
  SELECT 1 FROM leasing lc
   WHERE lc.unit_id = u.id AND lc.deleted_at IS NULL
     AND lc.start_date <= CURDATE() AND (lc.end_date IS NULL OR lc.end_date >= CURDATE()))`;
const NO_UPCOMING_LEASE = `NOT EXISTS (
  SELECT 1 FROM leasing lu
   WHERE lu.unit_id = u.id AND lu.deleted_at IS NULL AND lu.start_date > CURDATE())`;

function daysBetween(fromStr, toDate) {
  const from = new Date(fromStr + 'T00:00:00.000Z');
  return Math.round((toDate - from) / 86400000);
}

router.get('/vacancies', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    // 1. EXPIRING — current lease ending within its lead window, not re-let.
    const [expiring] = await req.pool.execute(
      `SELECT
          l.id AS lease_id, l.contract_type, l.amount AS rent, l.deposit,
          DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
          DATEDIFF(l.end_date, CURDATE()) AS days_left,
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          p.id AS property_id, p.display_name AS property_name, p.street_address,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ?
         AND l.deleted_at IS NULL
         AND u.active_status = 1
         AND l.start_date <= CURDATE()
         AND l.end_date IS NOT NULL
         AND l.end_date >= CURDATE()
         AND DATEDIFF(l.end_date, CURDATE()) <= ${LEAD_SQL}
         AND NOT EXISTS (
           SELECT 1 FROM leasing l2
            WHERE l2.unit_id = l.unit_id AND l2.deleted_at IS NULL
              AND l2.id <> l.id AND l2.start_date > l.end_date)
       ORDER BY days_left ASC`,
      [orgId]
    );

    // 2. VACANT NOW — active unit with no current AND no upcoming lease. Pull the
    // most-recent ended lease (for "vacant since" + last tenant/rent reference);
    // NULL for a never-leased unit.
    const [vacant] = await req.pool.execute(
      `SELECT
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          p.id AS property_id, p.display_name AS property_name, p.street_address,
          DATE_FORMAT(ll.end_date, '%Y-%m-%d') AS vacant_since,
          ll.amount AS rent, ll.deposit, ll.contract_type,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing ll ON ll.id = (
          SELECT le.id FROM leasing le
           WHERE le.unit_id = u.id AND le.deleted_at IS NULL
             AND le.end_date IS NOT NULL AND le.end_date < CURDATE()
           ORDER BY le.end_date DESC, le.id DESC LIMIT 1)
       LEFT JOIN tenant t ON t.id = ll.tenant_id
       WHERE p.org_id = ?
         AND u.active_status = 1
         AND ${NO_CURRENT_LEASE}
         AND ${NO_UPCOMING_LEASE}
         AND EXISTS (
           SELECT 1 FROM leasing le
            WHERE le.unit_id = u.id AND le.deleted_at IS NULL
              AND le.end_date IS NOT NULL AND le.end_date < CURDATE())`,
      [orgId]
    );

    const now = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

    const expiringRows = expiring.map(r => ({
      status: 'expiring',
      lease_id: String(r.lease_id),
      contract_type: r.contract_type,
      intent: INTENT[r.contract_type] || 'Unset',
      days_left: r.days_left != null ? Number(r.days_left) : null,   // days until vacant (positive)
      end_date: r.end_date,
      vacant_since: null,
      rent: r.rent != null ? Number(r.rent) : null,
      deposit: r.deposit != null ? Number(r.deposit) : null,
      unit_id: String(r.unit_id), unit_name: r.unit_name, unit_type: r.unit_type,
      beds: r.beds != null ? Number(r.beds) : null,
      baths: r.baths != null ? Number(r.baths) : null,
      size: r.size != null ? Number(r.size) : null,
      property_id: String(r.property_id), property_name: r.property_name, street_address: r.street_address,
      tenant_id: r.tenant_id ? String(r.tenant_id) : null,
      tenant_name: (r.tenant_name || '').trim() || '(no tenant)',
    }));

    const vacantRows = vacant.map(r => {
      const daysVacant = r.vacant_since ? daysBetween(r.vacant_since, now) : null;
      return {
        status: 'vacant',
        lease_id: null,
        contract_type: null,
        intent: null,
        // Negative = already vacant N days; null = never leased.
        days_left: daysVacant != null ? -daysVacant : null,
        days_vacant: daysVacant,
        end_date: null,
        vacant_since: r.vacant_since,   // null when never leased
        rent: r.rent != null ? Number(r.rent) : null,      // last lease rent (reference)
        deposit: r.deposit != null ? Number(r.deposit) : null,
        unit_id: String(r.unit_id), unit_name: r.unit_name, unit_type: r.unit_type,
        beds: r.beds != null ? Number(r.beds) : null,
        baths: r.baths != null ? Number(r.baths) : null,
        size: r.size != null ? Number(r.size) : null,
        property_id: String(r.property_id), property_name: r.property_name, street_address: r.street_address,
        tenant_id: r.tenant_id ? String(r.tenant_id) : null,   // last tenant
        tenant_name: (r.tenant_name || '').trim() || null,
      };
    });

    // Urgency sort: longest-vacant (most negative) → soonest-expiring (small
    // positive) → later-expiring → never-leased (no date) last.
    const NEVER_LEASED = Number.POSITIVE_INFINITY;
    const sortKey = (x) => (x.days_left == null ? NEVER_LEASED : x.days_left);
    const vacancies = [...vacantRows, ...expiringRows].sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return (a.property_name || '').localeCompare(b.property_name || '');
    });

    res.json({
      code: 200,
      data: {
        as_of: new Date().toISOString().slice(0, 10),
        lead_days: LEAD_DAYS,
        count: vacancies.length,
        vacant_count: vacantRows.length,
        expiring_count: expiringRows.length,
        vacancies,
      },
    });
  } catch (err) {
    console.error('[advertising/vacancies] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load vacancies' });
  }
});

module.exports = router;

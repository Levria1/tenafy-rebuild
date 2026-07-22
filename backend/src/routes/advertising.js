const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Advertising → Vacancy
// Units whose CURRENT lease is expiring soon and will need re-advertising.
//
// Keyed off DATE-COMPUTED lease status (start_date/end_date/CURDATE()), NOT the
// stored `leasing.status` column — that column is not maintained on expiry, so a
// unit re-let after a previous tenant left still carries stale status=1 rows.
//
// A unit appears once its current lease enters its renewal-intent lead window:
//   NR (contract_type 3) → 45 days before end_date
//   UC (contract_type 4) → 30 days
//   MR / MTM / unset     → 20 days
// Units that already have a replacement lease lined up (a lease starting after
// this one ends) are excluded — they are not a real upcoming gap.
// ---------------------------------------------------------------------------

const LEAD_DAYS = { NR: 45, UC: 30, DEFAULT: 20 };

// SQL lead-time by contract_type. 3=NR, 4=UC, everything else (1=MR, 2=MTM,
// 0/null=unset) = the 20-day default.
const LEAD_SQL = `CASE l.contract_type WHEN 3 THEN ${LEAD_DAYS.NR} WHEN 4 THEN ${LEAD_DAYS.UC} ELSE ${LEAD_DAYS.DEFAULT} END`;

router.get('/vacancies', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT
          l.id AS lease_id, l.lease_no, l.contract_type,
          l.amount AS rent, l.deposit,
          DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
          DATEDIFF(l.end_date, CURDATE()) AS days_left,
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type,
          u.beds, u.baths, u.size,
          p.id AS property_id, p.display_name AS property_name, p.street_address,
          t.id AS tenant_id,
          CASE WHEN t.type = 1 THEN t.company_name
               ELSE TRIM(CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))) END AS tenant_name
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
              AND l2.id <> l.id AND l2.start_date > l.end_date
         )
       ORDER BY days_left ASC, p.display_name ASC, u.name ASC`,
      [orgId]
    );

    const INTENT = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };
    const vacancies = rows.map(r => ({
      lease_id: String(r.lease_id),
      lease_no: r.lease_no,
      contract_type: r.contract_type,
      intent: INTENT[r.contract_type] || 'Unset',
      days_left: r.days_left != null ? Number(r.days_left) : null,
      end_date: r.end_date,
      rent: r.rent != null ? Number(r.rent) : null,
      deposit: r.deposit != null ? Number(r.deposit) : null,
      unit_id: String(r.unit_id),
      unit_name: r.unit_name,
      unit_type: r.unit_type,
      beds: r.beds != null ? Number(r.beds) : null,
      baths: r.baths != null ? Number(r.baths) : null,
      size: r.size != null ? Number(r.size) : null,
      property_id: String(r.property_id),
      property_name: r.property_name,
      street_address: r.street_address,
      tenant_id: r.tenant_id ? String(r.tenant_id) : null,
      tenant_name: (r.tenant_name || '').trim() || '(no tenant)',
    }));

    res.json({
      code: 200,
      data: {
        as_of: new Date().toISOString().slice(0, 10),
        lead_days: LEAD_DAYS,
        count: vacancies.length,
        vacancies,
      },
    });
  } catch (err) {
    console.error('[advertising/vacancies] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load vacancies' });
  }
});

module.exports = router;

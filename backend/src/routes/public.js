const express = require('express');
const router = express.Router();
const { authenticateApiKey } = require('../middleware/apiKeyAuth');

// All public routes require a valid API key
router.use(authenticateApiKey);

// GET /api/public/units/available?date=YYYY-MM-DD&propertyId=123
// Returns units available on the given date (defaults to today).
// A unit is "available" if it's active AND has no active lease covering that date.
router.get('/units/available', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const propertyId = req.query.propertyId || null;

    let whereClause = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1';
    const params = [orgId];

    if (propertyId) {
      whereClause += ' AND p.id = ?';
      params.push(propertyId);
    }

    // Get all active units, then LEFT JOIN to find any active lease covering the requested date.
    // Units with no overlapping lease are available.
    const [units] = await req.pool.execute(
      `SELECT
         u.id AS unit_id,
         u.name AS unit_name,
         u.type AS unit_type,
         u.amenity_type,
         p.id AS property_id,
         p.display_name AS property_name,
         p.street_address,
         p.city,
         p.state,
         p.country,
         p.zip_code,
         p.type AS property_type,
         last_lease.price AS last_lease_price,
         last_lease.end_date AS last_lease_end_date
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing active_lease
         ON active_lease.unit_id = u.id
         AND active_lease.deleted_at IS NULL
         AND active_lease.status = 1
         AND active_lease.start_date <= ?
         AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)
       LEFT JOIN (
         SELECT l1.unit_id, l1.price, l1.end_date
         FROM leasing l1
         INNER JOIN (
           SELECT unit_id, MAX(start_date) AS max_start
           FROM leasing
           WHERE deleted_at IS NULL
           GROUP BY unit_id
         ) l2 ON l1.unit_id = l2.unit_id AND l1.start_date = l2.max_start
         WHERE l1.deleted_at IS NULL
       ) last_lease ON last_lease.unit_id = u.id
       WHERE ${whereClause}
         AND active_lease.id IS NULL
       ORDER BY p.display_name, u.name`,
      [date, date, ...params]
    );

    res.json({
      code: 200,
      data: units,
      meta: {
        date,
        total: units.length,
      },
    });
  } catch (error) {
    console.error('Public available units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to fetch available units' });
  }
});

// GET /api/public/properties?active=1
// Returns properties with vacancy counts.
router.get('/properties', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const [properties] = await req.pool.execute(
      `SELECT
         p.id AS property_id,
         p.display_name AS property_name,
         p.street_address,
         p.city,
         p.state,
         p.country,
         p.zip_code,
         p.type AS property_type,
         COUNT(u.id) AS total_units,
         SUM(CASE
           WHEN u.active_status = 1 AND NOT EXISTS (
             SELECT 1 FROM leasing l
             WHERE l.unit_id = u.id AND l.deleted_at IS NULL AND l.status = 1
               AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
           ) THEN 1 ELSE 0
         END) AS available_units
       FROM property p
       LEFT JOIN unit u ON u.property_id = p.id AND u.active_status = 1
       WHERE p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.display_name`,
      [date, date, orgId]
    );

    res.json({
      code: 200,
      data: properties,
      meta: {
        date,
        total: properties.length,
      },
    });
  } catch (error) {
    console.error('Public properties error:', error);
    res.status(500).json({ code: 500, message: 'Failed to fetch properties' });
  }
});

module.exports = router;

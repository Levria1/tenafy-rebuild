const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');


// POST /api/service-vendor/services/:id - Get services assigned to a vendor (via service.assignee)
router.post('/services/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let whereClause = 's.assignee = ? AND s.org_id = ? AND s.deleted_at IS NULL';
    const params = [id, orgId];

    if (status !== undefined && status !== null) {
      whereClause += ' AND s.status = ?';
      params.push(status);
    }

    const [services] = await req.pool.execute(
      `SELECT s.*, u.name AS unit_name, p.display_name AS property_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              t.phone AS tenant_phone
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON s.created_by = t.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [...params]
    );
    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) AS total FROM service s WHERE ${whereClause}`,
      [...params]
    );

    res.json({ code: 200, data: { content: services, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('Get vendor services error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get vendor services' });
  }
});

// GET /api/service-vendor/:id - Get service vendor
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [vendors] = await req.pool.execute(
      'SELECT * FROM service_vendor WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );

    if (vendors.length === 0) {
      return res.status(404).json({ code: 404, message: 'Service vendor not found' });
    }

    res.json({ code: 200, data: vendors[0] });
  } catch (error) {
    console.error('Get service vendor error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get service vendor' });
  }
});

// POST /api/service-vendor - Create service vendor
router.post('/', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, id_card, birth_date, sex, notes, status } = req.body;
    const orgId = req.user.orgId;
    const vendorId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await req.pool.execute(
      `INSERT INTO service_vendor (id, org_id, first_name, last_name, email, phone, id_card, birth_date, sex, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [vendorId, orgId, first_name || null, last_name || null, email || null,
       phone || null, id_card || null, birth_date || null, sex ?? null, notes || null, status ?? 1]
    );

    res.json({ code: 200, message: 'Service vendor created', data: { id: vendorId } });
  } catch (error) {
    console.error('Create service vendor error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create service vendor' });
  }
});

// PUT /api/service-vendor/:id/update - Update service vendor
router.put('/:id/update', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, phone, id_card, birth_date, sex, notes, status } = req.body;
    const orgId = req.user.orgId;

    // Verify it exists
    const [existing] = await req.pool.execute(
      'SELECT id FROM service_vendor WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ code: 404, message: 'Service vendor not found' });
    }

    await req.pool.execute(
      `UPDATE service_vendor SET
        first_name = ?, last_name = ?, email = ?, phone = ?,
        id_card = ?, birth_date = ?, sex = ?, notes = ?, status = ?,
        updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [first_name || null, last_name || null, email || null, phone || null,
       id_card || null, birth_date || null, sex ?? null, notes || null, status ?? 1,
       id, orgId]
    );

    res.json({ code: 200, message: 'Service vendor updated' });
  } catch (error) {
    console.error('Update service vendor error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update service vendor' });
  }
});

// DELETE /api/service-vendor/:id - Soft-delete service vendor
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE service_vendor SET deleted_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Service vendor deleted' });
  } catch (error) {
    console.error('Delete service vendor error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete service vendor' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// GET /api/service-vendor/:id - Get service vendor
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [vendors] = await pool.execute(
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
    const { first_name, last_name, email, phone, id_card, birth_date, sex, notes } = req.body;
    const orgId = req.user.orgId;

    const [result] = await pool.execute(
      `INSERT INTO service_vendor (org_id, first_name, last_name, email, phone, id_card, birth_date, sex, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [orgId, first_name, last_name, email, phone || null, id_card || null, birth_date || null, sex || null, notes || null]
    );

    res.json({ code: 200, message: 'Service vendor created', data: { id: result.insertId } });
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

    await pool.execute(
      `UPDATE service_vendor SET
        first_name = ?, last_name = ?, email = ?, phone = ?,
        id_card = ?, birth_date = ?, sex = ?, notes = ?, status = ?,
        updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [first_name, last_name, email, phone || null,
       id_card || null, birth_date || null, sex || null, notes || null, status,
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
    await pool.execute('UPDATE service_vendor SET deleted_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Service vendor deleted' });
  } catch (error) {
    console.error('Delete service vendor error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete service vendor' });
  }
});

module.exports = router;

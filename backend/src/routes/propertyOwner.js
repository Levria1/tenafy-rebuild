const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');


// GET /api/property-owner/:id - Get property owner
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [owners] = await req.pool.execute(
      'SELECT * FROM property_owner WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );

    if (owners.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property owner not found' });
    }

    res.json({ code: 200, data: owners[0] });
  } catch (error) {
    console.error('Get property owner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property owner' });
  }
});

// POST /api/property-owner - Create property owner
router.post('/', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, id_card, birth_date, sex, notes } = req.body;
    const orgId = req.user.orgId;

    const [result] = await req.pool.execute(
      `INSERT INTO property_owner (org_id, first_name, last_name, email, phone, id_card, birth_date, sex, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [orgId, first_name, last_name, email, phone || null, id_card || null, birth_date || null, sex || null, notes || null]
    );

    res.json({ code: 200, message: 'Property owner created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create property owner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create property owner' });
  }
});

// PUT /api/property-owner/:id/update - Update property owner
router.put('/:id/update', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, phone, id_card, birth_date, sex, notes, status } = req.body;
    const orgId = req.user.orgId;

    await req.pool.execute(
      `UPDATE property_owner SET
        first_name = ?, last_name = ?, email = ?, phone = ?,
        id_card = ?, birth_date = ?, sex = ?, notes = ?, status = ?,
        updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [first_name, last_name, email, phone || null,
       id_card || null, birth_date || null, sex || null, notes || null, status,
       id, orgId]
    );

    res.json({ code: 200, message: 'Property owner updated' });
  } catch (error) {
    console.error('Update property owner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update property owner' });
  }
});

// DELETE /api/property-owner/:id - Soft-delete property owner
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE property_owner SET deleted_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Property owner deleted' });
  } catch (error) {
    console.error('Delete property owner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete property owner' });
  }
});

module.exports = router;

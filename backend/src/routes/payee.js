const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// GET /api/payee/:id - Get payee
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [payees] = await pool.execute(
      'SELECT * FROM payee WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    if (payees.length === 0) {
      return res.status(404).json({ code: 404, message: 'Payee not found' });
    }

    res.json({ code: 200, data: payees[0] });
  } catch (error) {
    console.error('Get payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get payee' });
  }
});

// POST /api/payee - Create payee
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, email, phone, type, address, notes } = req.body;
    const orgId = req.user.orgId;

    const [result] = await pool.execute(
      'INSERT INTO payee (org_id, name, email, phone, type, address, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, name, email, phone, type, address, notes]
    );

    res.json({ code: 200, message: 'Payee created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create payee' });
  }
});

// PUT /api/payee/:id/update - Update payee
router.put('/:id/update', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, type, address, notes, status } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE payee SET name = ?, email = ?, phone = ?, type = ?, address = ?, notes = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, email, phone, type, address, notes, status, id, orgId]
    );

    res.json({ code: 200, message: 'Payee updated' });
  } catch (error) {
    console.error('Update payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update payee' });
  }
});

// DELETE /api/payee/:id - Delete payee
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE payee SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Payee deleted' });
  } catch (error) {
    console.error('Delete payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete payee' });
  }
});

module.exports = router;

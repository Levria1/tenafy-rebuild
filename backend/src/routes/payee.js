const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');


// Payees are stored in the tenant table with category = 2

// GET /api/payee/:id - Get payee
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [payees] = await req.pool.execute(
      'SELECT * FROM tenant WHERE id = ? AND org_id = ? AND category = 2',
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
    const { first_name, last_name, email, phone, company_name, notes } = req.body;
    const orgId = req.user.orgId;
    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    await req.pool.execute(
      'INSERT INTO tenant (id, org_id, first_name, last_name, email, phone, company_name, notes, category, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 1, NOW())',
      [id.toString(), orgId, first_name, last_name, email, phone, company_name || null, notes || null]
    );

    res.json({ code: 200, message: 'Payee created', data: { id: id.toString() } });
  } catch (error) {
    console.error('Create payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create payee' });
  }
});

// PUT /api/payee/:id/update - Update payee
router.put('/:id/update', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, phone, company_name, notes, status } = req.body;
    const orgId = req.user.orgId;

    await req.pool.execute(
      'UPDATE tenant SET first_name = ?, last_name = ?, email = ?, phone = ?, company_name = ?, notes = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ? AND category = 2',
      [first_name, last_name, email, phone, company_name, notes, status ?? 1, id, orgId]
    );

    res.json({ code: 200, message: 'Payee updated' });
  } catch (error) {
    console.error('Update payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update payee' });
  }
});

// DELETE /api/payee/:id - Delete payee (soft delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE tenant SET status = 0, updated_at = NOW() WHERE id = ? AND org_id = ? AND category = 2', [id, orgId]);
    res.json({ code: 200, message: 'Payee deleted' });
  } catch (error) {
    console.error('Delete payee error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete payee' });
  }
});

module.exports = router;

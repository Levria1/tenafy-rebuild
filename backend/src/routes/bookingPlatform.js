const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

// GET / — list all enabled booking platforms
router.get('/', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT * FROM booking_platform WHERE org_id = ? AND enabled = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('[BookingPlatform] List error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load booking platforms' });
  }
});

// POST / — create
router.post('/', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
    const orgId = req.user.orgId;
    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    await req.pool.execute(
      'INSERT INTO booking_platform (id, org_id, name, enabled) VALUES (?, ?, ?, 1)',
      [id, orgId, name.trim()]
    );
    res.json({ code: 200, message: 'Booking platform created', data: { id } });
  } catch (err) {
    console.error('[BookingPlatform] Create error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create booking platform' });
  }
});

// PUT /:id — update
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
    const orgId = req.user.orgId;
    await req.pool.execute(
      'UPDATE booking_platform SET name = ? WHERE id = ? AND org_id = ?',
      [name.trim(), req.params.id, orgId]
    );
    res.json({ code: 200, message: 'Booking platform updated' });
  } catch (err) {
    console.error('[BookingPlatform] Update error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update booking platform' });
  }
});

// DELETE /:id — soft disable
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    // Check if any leases or invoices reference this platform
    const [[{ leaseCount }]] = await req.pool.execute(
      'SELECT COUNT(*) as leaseCount FROM leasing WHERE booking_platform_id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    const [[{ invoiceCount }]] = await req.pool.execute(
      'SELECT COUNT(*) as invoiceCount FROM invoice WHERE booking_platform_id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (Number(leaseCount) > 0 || Number(invoiceCount) > 0) {
      return res.status(400).json({
        code: 400,
        message: `Cannot delete — this platform is linked to ${Number(leaseCount)} lease(s) and ${Number(invoiceCount)} invoice(s). It will be disabled instead.`
      });
    }

    await req.pool.execute(
      'UPDATE booking_platform SET enabled = 0 WHERE id = ? AND org_id = ?',
      [req.params.id, orgId]
    );
    res.json({ code: 200, message: 'Booking platform deleted' });
  } catch (err) {
    console.error('[BookingPlatform] Delete error:', err);
    res.status(500).json({ code: 500, message: 'Failed to delete booking platform' });
  }
});

module.exports = router;

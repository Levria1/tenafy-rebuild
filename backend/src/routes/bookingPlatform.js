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
    const { name, requires_signature } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
    const orgId = req.user.orgId;
    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    const sig = requires_signature == null ? 1 : (requires_signature ? 1 : 0);
    await req.pool.execute(
      'INSERT INTO booking_platform (id, org_id, name, enabled, requires_signature) VALUES (?, ?, ?, 1, ?)',
      [id, orgId, name.trim(), sig]
    );
    res.json({ code: 200, message: 'Booking platform created', data: { id } });
  } catch (err) {
    console.error('[BookingPlatform] Create error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create booking platform' });
  }
});

// PUT /:id — update name and/or requires_signature
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name, requires_signature } = req.body;
    const orgId = req.user.orgId;
    // Dynamic SET — allow either field to be omitted.
    const sets = [];
    const params = [];
    if (name !== undefined) {
      if (!name || !name.trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
      sets.push('name = ?'); params.push(name.trim());
    }
    if (requires_signature !== undefined) {
      sets.push('requires_signature = ?'); params.push(requires_signature ? 1 : 0);
    }
    if (!sets.length) return res.status(400).json({ code: 400, message: 'No fields to update' });
    params.push(req.params.id, orgId);
    await req.pool.execute(
      `UPDATE booking_platform SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`,
      params
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

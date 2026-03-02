const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// GET /api/notification/list - Get notifications (paginated)
router.get('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const unreadOnly = req.query.unread === 'true';

    let whereClause = 'org_id = ?';
    const params = [orgId];
    if (unreadOnly) {
      whereClause += ' AND is_read = 0';
    }

    const [notifications] = await pool.execute(
      `SELECT * FROM notification WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM notification WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { content: notifications, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List notifications error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list notifications' });
  }
});

// GET /api/notification/unread-count - Get unread count
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[{ count }]] = await pool.execute(
      'SELECT COUNT(*) as count FROM notification WHERE org_id = ? AND is_read = 0',
      [orgId]
    );
    res.json({ code: 200, data: { count } });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get unread count' });
  }
});

// GET /api/notification/recent - Get 5 most recent for dropdown
router.get('/recent', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [notifications] = await pool.execute(
      'SELECT * FROM notification WHERE org_id = ? ORDER BY created_at DESC LIMIT 5',
      [orgId]
    );
    const [[{ count }]] = await pool.execute(
      'SELECT COUNT(*) as count FROM notification WHERE org_id = ? AND is_read = 0',
      [orgId]
    );
    res.json({ code: 200, data: { notifications, unreadCount: count } });
  } catch (error) {
    console.error('Get recent notifications error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get recent notifications' });
  }
});

// PUT /api/notification/:id/read - Mark one as read
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE notification SET is_read = 1, read_at = NOW() WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ code: 500, message: 'Failed to mark as read' });
  }
});

// PUT /api/notification/read-all - Mark all as read
router.put('/read-all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE notification SET is_read = 1, read_at = NOW() WHERE org_id = ? AND is_read = 0',
      [orgId]
    );
    res.json({ code: 200, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ code: 500, message: 'Failed to mark all as read' });
  }
});

// DELETE /api/notification/:id - Delete one notification
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute(
      'DELETE FROM notification WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Notification deleted' });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete notification' });
  }
});

module.exports = router;

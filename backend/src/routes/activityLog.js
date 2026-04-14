const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

// GET /api/activity-log/list - List activity logs with filters
router.get('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, action, entity_type, user_id, start_date, end_date, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = 'a.org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (a.username LIKE ? OR a.description LIKE ? OR a.entity_id LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (action) {
      whereClause += ' AND a.action = ?';
      params.push(action);
    }
    if (entity_type) {
      whereClause += ' AND a.entity_type = ?';
      params.push(entity_type);
    }
    if (user_id) {
      whereClause += ' AND a.user_id = ?';
      params.push(user_id);
    }
    if (start_date) {
      whereClause += ' AND a.created_at >= ?';
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ' AND a.created_at <= ?';
      params.push(end_date + ' 23:59:59');
    }

    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) as total FROM activity_log a WHERE ${whereClause}`,
      params
    );

    const [logs] = await req.pool.execute(
      `SELECT a.* FROM activity_log a
       WHERE ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT ${parseInt(limit)} OFFSET ${offset}`,
      params
    );

    res.json({
      code: 200,
      data: {
        content: logs,
        totalElements: total,
        totalPages: Math.ceil(total / parseInt(limit)),
        currentPage: parseInt(page),
      }
    });
  } catch (error) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get activity logs' });
  }
});

// GET /api/activity-log/users - List users who have activity (for filter dropdown)
router.get('/users', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [users] = await req.pool.execute(
      'SELECT DISTINCT user_id, username FROM activity_log WHERE org_id = ? AND username IS NOT NULL ORDER BY username',
      [orgId]
    );
    res.json({ code: 200, data: users });
  } catch (error) {
    console.error('Get activity log users error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get users' });
  }
});

// GET /api/activity-log/entity-types - List entity types (for filter dropdown)
router.get('/entity-types', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [types] = await req.pool.execute(
      'SELECT DISTINCT entity_type FROM activity_log WHERE org_id = ? ORDER BY entity_type',
      [orgId]
    );
    res.json({ code: 200, data: types.map(t => t.entity_type) });
  } catch (error) {
    console.error('Get entity types error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get entity types' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const bcrypt = require('bcryptjs');

// GET /api/user/profile - Get current user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const [users] = await pool.execute(
      'SELECT id, username, email, first_name, last_name, phone, status, created_at FROM user WHERE id = ?',
      [userId]
    );
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: 'User not found' });
    }
    res.json({ code: 200, data: users[0] });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get profile' });
  }
});

// PUT /api/user/personal - Update personal info
router.put('/personal', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { first_name, last_name, phone, email } = req.body;
    await pool.execute(
      'UPDATE user SET first_name = ?, last_name = ?, phone = ?, email = ?, updated_at = NOW() WHERE id = ?',
      [first_name, last_name, phone, email, userId]
    );
    res.json({ code: 200, message: 'Personal info updated' });
  } catch (error) {
    console.error('Update personal error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update personal info' });
  }
});

// GET /api/user/setting - Get user/org settings
router.get('/setting', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [orgs] = await pool.execute('SELECT * FROM organization WHERE id = ?', [orgId]);
    if (orgs.length === 0) {
      return res.status(404).json({ code: 404, message: 'Organization not found' });
    }
    res.json({ code: 200, data: orgs[0] });
  } catch (error) {
    console.error('Get setting error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get setting' });
  }
});

// GET /api/user/dashboard - Get dashboard stats
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    const [[{ totalUnits }]] = await pool.execute(
      'SELECT COUNT(*) as totalUnits FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1',
      [orgId]
    );
    const [[{ occupiedUnits }]] = await pool.execute(
      'SELECT COUNT(*) as occupiedUnits FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1 AND u.status = 1',
      [orgId]
    );
    const [[{ totalProperties }]] = await pool.execute(
      'SELECT COUNT(*) as totalProperties FROM property WHERE org_id = ? AND status = 1',
      [orgId]
    );
    const [[{ expiringLeases }]] = await pool.execute(
      `SELECT COUNT(*) as expiringLeases FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL AND l.status = 1
         AND DATEDIFF(l.end_date, NOW()) BETWEEN 0 AND 30`,
      [orgId]
    );
    const [[{ pendingInvoices }]] = await pool.execute(
      'SELECT COUNT(*) as pendingInvoices FROM invoice WHERE org_id = ? AND status = 0',
      [orgId]
    );

    const occupancyRate = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0;

    res.json({
      code: 200,
      data: { totalUnits, occupiedUnits, totalProperties, expiringLeases, pendingInvoices, occupancyRate }
    });
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get dashboard' });
  }
});

// PUT /api/user/dashboard - Update dashboard preferences (stub)
router.put('/dashboard', authenticate, async (req, res) => {
  res.json({ code: 200, message: 'Dashboard updated' });
});

// PUT /api/user/status/update - Update user status
router.put('/status/update', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;
    await pool.execute('UPDATE user SET status = ?, updated_at = NOW() WHERE id = ?', [status, userId]);
    res.json({ code: 200, message: 'Status updated' });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update status' });
  }
});

// POST /api/users - List users with paging
router.post('/users', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (username LIKE ? OR email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s);
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const [users] = await pool.execute(
      'SELECT id, username, email, first_name, last_name, status, created_at FROM user WHERE ' + whereClause + ' ORDER BY created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM user WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: users, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list users' });
  }
});

// POST /api/user - Create user
router.post('/user', authenticate, async (req, res) => {
  try {
    const { username, email, password, first_name, last_name, role } = req.body;
    const orgId = req.user.orgId;
    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await pool.execute(
      'INSERT INTO user (org_id, username, password, email, first_name, last_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, username, '{bcrypt}' + hashedPassword, email, first_name, last_name, role || 'user']
    );
    res.json({ code: 200, message: 'User created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create user' });
  }
});

// PUT /api/user/:id - Update user
router.put('/user/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, first_name, last_name, role, status } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE user SET username = ?, email = ?, first_name = ?, last_name = ?, role = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [username, email, first_name, last_name, role, status, id, orgId]
    );
    res.json({ code: 200, message: 'User updated' });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update user' });
  }
});

// DELETE /api/user/:id - Delete user
router.delete('/user/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE user SET status = 0, updated_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'User deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete user' });
  }
});

// GET /api/user/:id - Get user detail
router.get('/user/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [users] = await pool.execute(
      'SELECT id, username, email, first_name, last_name, role, status, created_at FROM user WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: 'User not found' });
    }
    res.json({ code: 200, data: users[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get user' });
  }
});

module.exports = router;

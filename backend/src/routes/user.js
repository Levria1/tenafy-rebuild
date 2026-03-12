const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const bcrypt = require('bcryptjs');

// GET /api/user/profile - Get current user profile with permissions
router.get('/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const orgType = req.user.orgType;
    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status, u.created_at,
              ur.role_id, r.display_name as role_name
       FROM user u
       LEFT JOIN user_role ur ON u.id = ur.user_id
       LEFT JOIN role r ON ur.role_id = r.id
       WHERE u.id = ?`,
      [userId]
    );
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: 'User not found' });
    }

    // Load permissions
    let permissions = [];
    if (Number(orgType) === 6) {
      permissions = ['*'];
    } else {
      const [perms] = await pool.execute(
        `SELECT rp.permission_code FROM role_permission rp
         JOIN user_role ur ON rp.role_id = ur.role_id
         WHERE ur.user_id = ?`,
        [userId]
      );
      permissions = perms.map(p => p.permission_code);
    }

    res.json({ code: 200, data: { ...users[0], orgType: Number(orgType), permissions } });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get profile' });
  }
});

// PUT /api/user/personal - Update personal info
router.put('/personal', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { first_name, last_name, email } = req.body;
    await pool.execute(
      'UPDATE user SET first_name = ?, last_name = ?, email = ?, updated_at = NOW() WHERE id = ?',
      [first_name, last_name, email, userId]
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

// GET /api/user/dashboard - Get full dashboard data for all widgets
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const expiringDays = parseInt(req.query.expiringDays) || 30;
    const vacantDays = parseInt(req.query.vacantDays) || 30;

    // --- Occupancy Rate ---
    const [[{ totalUnits }]] = await pool.execute(
      'SELECT COUNT(*) as totalUnits FROM unit u JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1',
      [orgId]
    );
    const [[{ occupiedUnits }]] = await pool.execute(
      'SELECT COUNT(*) as occupiedUnits FROM unit u JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1 AND u.status = 1',
      [orgId]
    );
    const vacantCount = totalUnits - occupiedUnits;
    const occupancyRate = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 10000) / 100 : 0;

    // --- Vacant Units (no active lease) ---
    const [vacantUnits] = await pool.execute(
      `SELECT u.id AS unit_id, p.display_name AS property, u.name AS unit_name, u.type AS unit_type,
              u.rent_price_min, u.rent_price_max, p.id AS property_id
       FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND u.active_status = 1 AND u.status = 0
         AND NOT EXISTS (SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.status = 1 AND l.deleted_at IS NULL)
       ORDER BY p.display_name, u.name
       LIMIT 20`,
      [orgId]
    );

    // --- Overdue Rental Amount (rent invoices that are overdue, status=2) ---
    // Find rent category IDs (categories with 'rental' in the name)
    const [rentCategories] = await pool.execute(
      "SELECT id FROM category_setting WHERE org_id = ? AND LOWER(name) LIKE '%rental%'",
      [orgId]
    );
    const rentCatIds = rentCategories.map(c => c.id.toString());
    // Rent invoice condition (with alias for JOINed queries, without alias for simple queries)
    const rentCondition = rentCatIds.length > 0
      ? `AND i.category IN (${rentCatIds.map(() => '?').join(',')})`
      : 'AND 1=0';
    const rentConditionSimple = rentCatIds.length > 0
      ? `AND category IN (${rentCatIds.map(() => '?').join(',')})`
      : 'AND 1=0';
    const nonRentCondition = rentCatIds.length > 0
      ? `AND i.category NOT IN (${rentCatIds.map(() => '?').join(',')})`
      : '';
    const nonRentConditionSimple = rentCatIds.length > 0
      ? `AND category NOT IN (${rentCatIds.map(() => '?').join(',')})`
      : '';

    const [overdueRentals] = await pool.execute(
      `SELECT i.id, p.display_name AS property, u.name AS unit_name,
              i.due_on, i.amount AS outstanding,
              GREATEST(DATEDIFF(CURDATE(), i.due_on), 0) AS days_late,
              t.first_name, t.last_name
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       WHERE i.org_id = ? AND i.status = 2 AND i.deleted_at IS NULL ${rentCondition}
       ORDER BY days_late DESC
       LIMIT 20`,
      [orgId, ...rentCatIds]
    );
    const [[{ overdueRentalTotal }]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS overdueRentalTotal FROM invoice WHERE org_id = ? AND status = 2 AND deleted_at IS NULL ${rentConditionSimple}`,
      [orgId, ...rentCatIds]
    );
    const [[{ overdueRentalCount }]] = await pool.execute(
      `SELECT COUNT(*) AS overdueRentalCount FROM invoice WHERE org_id = ? AND status = 2 AND deleted_at IS NULL ${rentConditionSimple}`,
      [orgId, ...rentCatIds]
    );

    // --- Overdue Payments (non-rent overdue invoices, status=2, EXCLUDING rent category) ---
    const [overduePayments] = await pool.execute(
      `SELECT i.id, p.display_name AS property, u.name AS unit_name,
              i.due_on AS due_date, i.amount AS outstanding,
              GREATEST(DATEDIFF(CURDATE(), i.due_on), 0) AS days_late,
              t.first_name, t.last_name
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       WHERE i.org_id = ? AND i.status = 2 AND i.deleted_at IS NULL ${nonRentCondition}
       ORDER BY days_late DESC
       LIMIT 20`,
      [orgId, ...rentCatIds]
    );
    const [[{ overduePaymentTotal }]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS overduePaymentTotal FROM invoice WHERE org_id = ? AND status = 2 AND deleted_at IS NULL ${nonRentConditionSimple}`,
      [orgId, ...rentCatIds]
    );
    const [[{ overduePaymentCount }]] = await pool.execute(
      `SELECT COUNT(*) AS overduePaymentCount FROM invoice WHERE org_id = ? AND status = 2 AND deleted_at IS NULL ${nonRentConditionSimple}`,
      [orgId, ...rentCatIds]
    );

    // --- Outstanding Balance (per tenant - ALL overdue invoices status=2, all categories) ---
    const [outstandingBalance] = await pool.execute(
      `SELECT t.id AS tenant_id, t.first_name, t.last_name,
              SUM(i.amount) AS outstanding,
              GREATEST(DATEDIFF(CURDATE(), MIN(i.due_on)), 0) AS days_late
       FROM invoice i
       JOIN tenant t ON i.tenant_id = t.id
       WHERE i.org_id = ? AND i.status = 2 AND i.deleted_at IS NULL
       GROUP BY t.id, t.first_name, t.last_name
       HAVING outstanding > 0
       ORDER BY outstanding DESC
       LIMIT 20`,
      [orgId]
    );
    const [[{ outstandingTotal }]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) AS outstandingTotal FROM invoice WHERE org_id = ? AND status = 2 AND deleted_at IS NULL',
      [orgId]
    );

    // --- Expiring Leases ---
    const [expiringLeases] = await pool.execute(
      `SELECT l.id AS lease_id, p.display_name AS property, p.id AS property_id,
              u.name AS unit_name,
              t.first_name, t.last_name,
              l.end_date AS lease_end_date
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL AND l.status = 1
         AND l.end_date IS NOT NULL
         AND DATEDIFF(l.end_date, CURDATE()) BETWEEN 0 AND ?
       ORDER BY l.end_date ASC
       LIMIT 20`,
      [orgId, expiringDays]
    );
    const [[{ expiringCount }]] = await pool.execute(
      `SELECT COUNT(*) AS expiringCount FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL AND l.status = 1
         AND l.end_date IS NOT NULL
         AND DATEDIFF(l.end_date, CURDATE()) BETWEEN 0 AND ?`,
      [orgId, expiringDays]
    );

    // --- Upcoming Vacant Units (leases ending soon) ---
    const [upcomingVacant] = await pool.execute(
      `SELECT p.display_name AS property, p.id AS property_id,
              u.name AS unit_name, u.type AS unit_type,
              l.end_date AS lease_end_date
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL AND l.status = 1
         AND l.end_date IS NOT NULL
         AND DATEDIFF(l.end_date, CURDATE()) BETWEEN 0 AND ?
         AND NOT EXISTS (
           SELECT 1 FROM leasing l2 WHERE l2.unit_id = u.id AND l2.deleted_at IS NULL
             AND l2.id != l.id AND l2.start_date > l.end_date AND l2.status IN (0, 1)
         )
       ORDER BY l.end_date ASC
       LIMIT 20`,
      [orgId, vacantDays]
    );
    const [[{ upcomingVacantCount }]] = await pool.execute(
      `SELECT COUNT(*) AS upcomingVacantCount FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL AND l.status = 1
         AND l.end_date IS NOT NULL
         AND DATEDIFF(l.end_date, CURDATE()) BETWEEN 0 AND ?
         AND NOT EXISTS (
           SELECT 1 FROM leasing l2 WHERE l2.unit_id = u.id AND l2.deleted_at IS NULL
             AND l2.id != l.id AND l2.start_date > l.end_date AND l2.status IN (0, 1)
         )`,
      [orgId, vacantDays]
    );

    // --- Recent Service Requests ---
    const [serviceRequests] = await pool.execute(
      `SELECT s.id, s.code, s.category, s.sub_category, s.status, s.created_at,
              s.preferred_date_first_start,
              p.display_name AS property, u.name AS unit_name
       FROM service s
       JOIN unit u ON s.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE s.org_id = ? AND s.deleted_at IS NULL AND s.status IN (0, 1)
       ORDER BY s.created_at DESC
       LIMIT 10`,
      [orgId]
    );

    res.json({
      code: 200,
      data: {
        occupancy: { totalUnits, occupiedUnits, vacantCount, occupancyRate },
        vacantUnits,
        overdueRentals: { items: overdueRentals, total: overdueRentalTotal, count: overdueRentalCount },
        overduePayments: { items: overduePayments, total: overduePaymentTotal, count: overduePaymentCount },
        outstandingBalance: { items: outstandingBalance, total: outstandingTotal },
        expiringLeases: { items: expiringLeases, count: expiringCount },
        upcomingVacant: { items: upcomingVacant, count: upcomingVacantCount },
        serviceRequests,
      },
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

// POST /api/user/list - List users with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'u.org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (u.username LIKE ? OR u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s);
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND u.status = ?';
      params.push(status);
    }

    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status, u.created_at,
              ur.role_id, r.display_name as role_name
       FROM user u
       LEFT JOIN user_role ur ON u.id = ur.user_id
       LEFT JOIN role r ON ur.role_id = r.id
       WHERE ${whereClause}
       ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM user u WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: users, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list users' });
  }
});

// POST /api/user - Create user
router.post('/', authenticate, async (req, res) => {
  try {
    const { username, email, password, first_name, last_name, role_id } = req.body;
    const orgId = req.user.orgId;
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    await pool.execute(
      'INSERT INTO user (id, org_id, username, password, email, first_name, last_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [userId.toString(), orgId, username, '{bcrypt}' + hashedPassword, email || null, first_name || null, last_name || null]
    );

    // Assign role via user_role junction table
    if (role_id) {
      await pool.execute(
        'INSERT INTO user_role (user_id, role_id) VALUES (?, ?)',
        [userId.toString(), role_id]
      );
    }

    res.json({ code: 200, message: 'User created', data: { id: userId.toString() } });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create user' });
  }
});

// PUT /api/user/:id - Update user
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, first_name, last_name, role_id, status } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE user SET email = ?, first_name = ?, last_name = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [email || null, first_name || null, last_name || null, status ?? 1, id, orgId]
    );

    // Update role assignment via user_role junction table
    if (role_id !== undefined) {
      await pool.execute('DELETE FROM user_role WHERE user_id = ?', [id]);
      if (role_id) {
        await pool.execute('INSERT INTO user_role (user_id, role_id) VALUES (?, ?)', [id, role_id]);
      }
    }

    res.json({ code: 200, message: 'User updated' });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update user' });
  }
});

// DELETE /api/user/:id - Delete user (soft delete + remove role assignment)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('DELETE FROM user_role WHERE user_id = ?', [id]);
    await pool.execute('UPDATE user SET status = 0, updated_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'User deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete user' });
  }
});

// GET /api/user/:id - Get user detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status, u.created_at,
              ur.role_id, r.display_name as role_name
       FROM user u
       LEFT JOIN user_role ur ON u.id = ur.user_id
       LEFT JOIN role r ON ur.role_id = r.id
       WHERE u.id = ? AND u.org_id = ?`,
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

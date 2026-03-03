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

    // --- Overdue Rental Invoices (tenant invoices past due) ---
    const [overdueRentals] = await pool.execute(
      `SELECT i.id, p.display_name AS property, u.name AS unit_name,
              i.due_on, i.amount AS outstanding,
              DATEDIFF(CURDATE(), i.due_on) AS days_late,
              t.first_name, t.last_name
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       WHERE i.org_id = ? AND i.status = 2
       ORDER BY days_late DESC
       LIMIT 20`,
      [orgId]
    );
    const [[{ overdueRentalTotal }]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) AS overdueRentalTotal FROM invoice WHERE org_id = ? AND status = 2',
      [orgId]
    );
    const [[{ overdueRentalCount }]] = await pool.execute(
      'SELECT COUNT(*) AS overdueRentalCount FROM invoice WHERE org_id = ? AND status = 2',
      [orgId]
    );

    // --- Overdue Payments (owner payments - accounting outflows overdue) ---
    // type is on `accounting` table (0=outflow, 1=inflow), not on accounting_line
    const [overduePayments] = await pool.execute(
      `SELECT a.id, p.display_name AS property, a.payment_date AS due_date,
              al.amount AS outstanding,
              DATEDIFF(CURDATE(), a.payment_date) AS days_late
       FROM accounting a
       JOIN accounting_line al ON al.accounting_id = a.id
       LEFT JOIN property p ON al.property_id = p.id
       WHERE a.org_id = ? AND a.deleted_at IS NULL AND a.type = 0
         AND a.payment_date < CURDATE()
       ORDER BY days_late DESC
       LIMIT 20`,
      [orgId]
    );
    const [[{ overduePaymentTotal }]] = await pool.execute(
      `SELECT COALESCE(SUM(al.amount), 0) AS overduePaymentTotal
       FROM accounting a
       JOIN accounting_line al ON al.accounting_id = a.id
       WHERE a.org_id = ? AND a.deleted_at IS NULL AND a.type = 0
         AND a.payment_date < CURDATE()`,
      [orgId]
    );

    // --- Outstanding Balance (per tenant) ---
    const [outstandingBalance] = await pool.execute(
      `SELECT t.id AS tenant_id, t.first_name, t.last_name,
              SUM(i.amount) AS outstanding,
              MAX(DATEDIFF(CURDATE(), i.due_on)) AS days_late
       FROM invoice i
       JOIN tenant t ON i.tenant_id = t.id
       WHERE i.org_id = ? AND i.status IN (0, 2)
       GROUP BY t.id, t.first_name, t.last_name
       HAVING outstanding > 0
       ORDER BY outstanding DESC
       LIMIT 20`,
      [orgId]
    );
    const [[{ outstandingTotal }]] = await pool.execute(
      'SELECT COALESCE(SUM(amount), 0) AS outstandingTotal FROM invoice WHERE org_id = ? AND status IN (0, 2)',
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
        overduePayments: { items: overduePayments, total: overduePaymentTotal, count: overduePayments.length },
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

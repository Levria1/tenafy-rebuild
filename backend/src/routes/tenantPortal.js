const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { authenticate } = require('../middleware/auth');

const config = require('../config');
const { orgTodaySql } = require('../utils/orgTime');

// POST /api/tenant-portal/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ code: 400, message: 'Email and password are required' });
    }

    // Look up user by email
    const [users] = await req.pool.execute(
      'SELECT id, username, password, email, org_id, first_name, last_name, status FROM user WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ code: 9000, message: 'Invalid email or password' });
    }

    const user = users[0];

    if (user.status !== 1) {
      return res.status(401).json({ code: 9010, message: 'Account is inactive' });
    }

    let storedHash = user.password;
    if (storedHash.startsWith('{bcrypt}')) {
      storedHash = storedHash.replace('{bcrypt}', '');
    }
    if (storedHash.startsWith('$2a$')) {
      storedHash = storedHash.replace('$2a$', '$2b$');
    }

    const isValidPassword = await bcrypt.compare(password, storedHash);

    if (!isValidPassword) {
      return res.status(401).json({ code: 9000, message: 'Invalid email or password' });
    }

    // Find associated tenant record by user email
    const [tenants] = await req.pool.execute(
      'SELECT id, org_id FROM tenant WHERE email = ? AND org_id = ? LIMIT 1',
      [email, user.org_id]
    );

    if (tenants.length === 0) {
      return res.status(403).json({ code: 403, message: 'No tenant account associated with this user' });
    }

    const tenantRecord = tenants[0];

    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: tenantRecord.id,
        orgId: user.org_id,
        role: 'tenant',
      },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.cookie('__s_t', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7200 * 1000,
    });

    res.json({
      code: 200,
      message: 'Login successful',
      data: { token },
    });
  } catch (error) {
    console.error('Tenant portal login error:', error);
    res.status(500).json({ code: 500, message: 'Login failed' });
  }
});

// GET /api/tenant-portal/dashboard
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const orgId = req.user.orgId;

    if (!tenantId) {
      return res.status(403).json({ code: 403, message: 'Tenant access required' });
    }

    // Active leases count - JOIN through unit→property for org scoping
    const [[{ activeLeases }]] = await req.pool.execute(
      `SELECT COUNT(*) as activeLeases
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE l.tenant_id = ? AND p.org_id = ? AND l.deleted_at IS NULL
         AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)`,
      [tenantId, orgId]
    );

    // Unpaid invoices count + outstanding amount + next due date
    const [[invoiceSummary]] = await req.pool.execute(
      `SELECT
         COUNT(*) as unpaidInvoices,
         COALESCE(SUM(amount), 0) as outstandingAmount,
         MIN(due_on) as nextDueDate
       FROM invoice
       WHERE tenant_id = ? AND org_id = ? AND status = 0`,
      [tenantId, orgId]
    );

    // Next due invoice amount
    let nextDueAmount = null;
    if (invoiceSummary.nextDueDate) {
      const [[nextInvoice]] = await req.pool.execute(
        `SELECT amount FROM invoice
         WHERE tenant_id = ? AND org_id = ? AND status = 0 AND due_on = ?
         LIMIT 1`,
        [tenantId, orgId, invoiceSummary.nextDueDate]
      );
      nextDueAmount = nextInvoice ? nextInvoice.amount : null;
    }

    res.json({
      code: 200,
      data: {
        activeLeases: activeLeases || 0,
        unpaidInvoices: invoiceSummary.unpaidInvoices || 0,
        outstandingAmount: invoiceSummary.outstandingAmount || 0,
        nextDueDate: invoiceSummary.nextDueDate || null,
        nextDueAmount: nextDueAmount || 0,
      },
    });
  } catch (error) {
    console.error('Tenant portal dashboard error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load dashboard' });
  }
});

// GET /api/tenant-portal/leases
router.get('/leases', authenticate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const orgId = req.user.orgId;

    if (!tenantId) {
      return res.status(403).json({ code: 403, message: 'Tenant access required' });
    }

    const [leases] = await req.pool.execute(
      `SELECT
         l.id,
         l.start_date,
         l.end_date,
         l.price,
         l.status,
         p.display_name as property_name,
         u.name as unit_name
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE l.tenant_id = ? AND p.org_id = ?
       ORDER BY l.start_date DESC`,
      [tenantId, orgId]
    );

    res.json({ code: 200, data: leases });
  } catch (error) {
    console.error('Tenant portal leases error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load leases' });
  }
});

// GET /api/tenant-portal/invoices
router.get('/invoices', authenticate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const orgId = req.user.orgId;

    if (!tenantId) {
      return res.status(403).json({ code: 403, message: 'Tenant access required' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [invoices] = await req.pool.execute(
      `SELECT id, invoice_code, note, amount, due_on, status, created_at
       FROM invoice
       WHERE tenant_id = ? AND org_id = ?
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [tenantId, orgId]
    );

    const [[{ total }]] = await req.pool.execute(
      'SELECT COUNT(*) as total FROM invoice WHERE tenant_id = ? AND org_id = ?',
      [tenantId, orgId]
    );

    res.json({
      code: 200,
      data: {
        content: invoices,
        totalElements: total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
      },
    });
  } catch (error) {
    console.error('Tenant portal invoices error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load invoices' });
  }
});

// GET /api/tenant-portal/profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const orgId = req.user.orgId;

    if (!tenantId) {
      return res.status(403).json({ code: 403, message: 'Tenant access required' });
    }

    const [tenants] = await req.pool.execute(
      `SELECT id, first_name, last_name, email, phone, status, created_at
       FROM tenant
       WHERE id = ? AND org_id = ?`,
      [tenantId, orgId]
    );

    if (tenants.length === 0) {
      return res.status(404).json({ code: 404, message: 'Tenant profile not found' });
    }

    res.json({ code: 200, data: tenants[0] });
  } catch (error) {
    console.error('Tenant portal profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load profile' });
  }
});

// PUT /api/tenant-portal/profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const orgId = req.user.orgId;

    if (!tenantId) {
      return res.status(403).json({ code: 403, message: 'Tenant access required' });
    }

    const { phone } = req.body;

    await req.pool.execute(
      'UPDATE tenant SET phone = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [phone || null, tenantId, orgId]
    );

    res.json({ code: 200, message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Tenant portal update profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update profile' });
  }
});

module.exports = router;

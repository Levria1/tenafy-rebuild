const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/leasing/list - List leases with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status, startDate, endDate, type, tenantStatus, propertyId, sortField, sortOrder } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'p.org_id = ? AND l.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (u.name LIKE ? OR p.display_name LIKE ? OR t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(t.first_name, " ", t.last_name) LIKE ?)';
      const searchParam = '%' + search + '%';
      params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND l.status = ?';
      params.push(status);
    }
    if (type !== undefined && type !== null) {
      whereClause += ' AND l.type = ?';
      params.push(type);
    }
    if (tenantStatus !== undefined && tenantStatus !== null) {
      whereClause += ' AND t.status = ?';
      params.push(tenantStatus);
    }
    if (propertyId) {
      whereClause += ' AND (p.id = ? OR u.property_id = ?)';
      params.push(propertyId, propertyId);
    }
    if (startDate) {
      whereClause += ' AND l.start_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND l.end_date <= ?';
      params.push(endDate);
    }

    // Sorting
    const allowedSortFields = {
      tenant: 't.first_name',
      property: 'p.display_name',
      start_date: 'l.start_date',
      end_date: 'l.end_date',
      status: 'l.status',
      price: 'l.amount',
      phone: 't.phone',
    };
    let orderBy = 't.first_name ASC, t.last_name ASC';
    if (sortField && allowedSortFields[sortField]) {
      const dir = sortOrder === 'descend' ? 'DESC' : 'ASC';
      orderBy = `${allowedSortFields[sortField]} ${dir}`;
    }

    const [leases] = await pool.execute(
      `SELECT l.*, u.name as unit_name, p.display_name as property_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              t.phone as tenant_phone, t.status as tenant_status
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM leasing l LEFT JOIN unit u ON l.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id LEFT JOIN tenant t ON l.tenant_id = t.id WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { content: leases, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List leases error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list leases' });
  }
});

// GET /api/leasing/:id - Get lease detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [leases] = await pool.execute(
      'SELECT l.*, u.name as unit_name, p.display_name as property_name, t.first_name as tenant_first_name, t.last_name as tenant_last_name, t.email as tenant_email, t.phone as tenant_phone FROM leasing l LEFT JOIN unit u ON l.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id LEFT JOIN tenant t ON l.tenant_id = t.id WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL',
      [id, orgId]
    );
    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }
    res.json({ code: 200, data: leases[0] });
  } catch (error) {
    console.error('Get lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get lease' });
  }
});

// POST /api/leasing/check-conflict - Check for conflicting leases on a unit
router.post('/check-conflict', authenticate, async (req, res) => {
  try {
    const { unit_id, start_date, end_date, exclude_lease_id } = req.body;
    if (!unit_id || !start_date) {
      return res.json({ code: 200, data: { conflict: false } });
    }

    let query = `SELECT l.id, l.start_date, l.end_date, t.first_name, t.last_name, l.lease_no
      FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
      WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.status = 1
        AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)`;
    const params = [unit_id, end_date || '2099-12-31', start_date];

    if (exclude_lease_id) {
      query += ' AND l.id != ?';
      params.push(exclude_lease_id);
    }

    const [conflicts] = await pool.execute(query, params);

    if (conflicts.length > 0) {
      const c = conflicts[0];
      const tenantName = [c.first_name, c.last_name].filter(Boolean).join(' ');
      return res.json({
        code: 200,
        data: {
          conflict: true,
          message: `Conflicts with lease ${c.lease_no || '#' + c.id} (${tenantName}): ${c.start_date} to ${c.end_date}`,
          lease: c
        }
      });
    }

    res.json({ code: 200, data: { conflict: false } });
  } catch (error) {
    console.error('Check conflict error:', error);
    res.status(500).json({ code: 500, message: 'Failed to check conflicts' });
  }
});

// POST /api/leasing - Create lease
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      unit_id, tenant_id, start_date, end_date, type,
      price, deposit, due_date, invoicing, amount, first_invoice_date,
      contract_type, unit_information, note, credits,
      contact_phone, lease_no,
      // notification flags
      tenant_posted, landlord_posted, landlord_due, tenant_due,
      landlord_overdue, tenant_overdue, landlord_expired, landlord_expired_days,
      tenant_checkin, tenant_checkout, tenant_renewal, tenant_renewal_days,
      tenant_deposit_posted,
      // email
      email_template_id, access_setting, share_lease, all_past,
      mark_past_paid
    } = req.body;
    const orgId = req.user.orgId;

    // Generate lease ID (snowflake-style)
    const leaseId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    // Generate lease_no from sequence
    let leaseNo = lease_no || null;
    if (!leaseNo) {
      const [[seq]] = await pool.execute(
        'SELECT id, seq_next, pattern FROM sequence WHERE org_id = ? AND `key` = ? FOR UPDATE',
        [orgId, 'leasing_code']
      );
      if (seq) {
        leaseNo = seq.pattern
          .replace(/\{d,(\w+)\}/g, () => {
            const now = new Date();
            return now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
          })
          .replace(/\{#,(\d+)\}/, (_, pad) => String(seq.seq_next).padStart(parseInt(pad), '0'));
        await pool.execute('UPDATE sequence SET seq_next = seq_next + 1 WHERE id = ?', [seq.id]);
      }
    }

    // Get currency
    const [[cur]] = await pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
    const currencyId = cur ? cur.id : null;

    await pool.execute(
      `INSERT INTO leasing (
        id, unit_id, tenant_id, start_date, end_date, status, price, type, invoicing,
        amount, due_date, deposit, currency_id, contract_type, unit_information, note, credits,
        contact_phone, lease_no, first_invoice_date,
        access_setting, share_lease, all_past,
        tenant_posted, landlord_posted, landlord_due, tenant_due,
        landlord_overdue, tenant_overdue, landlord_expired, landlord_expired_days,
        tenant_checkin, tenant_checkout, tenant_renewal, tenant_renewal_days,
        tenant_deposit_posted, email_template_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        leaseId.toString(), unit_id, tenant_id, start_date, end_date || null,
        price || 0, type || 0, invoicing || null,
        amount || price || 0, due_date || null, deposit || 0, currencyId,
        contract_type || 0, unit_information || null, note || null, credits || null,
        contact_phone || null, leaseNo, first_invoice_date || null,
        access_setting || null, share_lease ? 1 : 0, all_past ? 1 : 0,
        tenant_posted ? 1 : 0, landlord_posted ? 1 : 0,
        landlord_due ? 1 : 0, tenant_due ? 1 : 0,
        landlord_overdue ? 1 : 0, tenant_overdue ? 1 : 0,
        landlord_expired ? 1 : 0, landlord_expired_days || 0,
        tenant_checkin ? 1 : 0, tenant_checkout ? 1 : 0,
        tenant_renewal ? 1 : 0, tenant_renewal_days || 0,
        tenant_deposit_posted ? 1 : 0, email_template_id || null
      ]
    );

    // Mark unit as occupied
    await pool.execute('UPDATE unit SET status = 1 WHERE id = ?', [unit_id]);

    // Create first invoice if recurring is enabled and amount is set
    if (invoicing && (amount || price)) {
      const invoiceAmount = amount || price;
      const invoiceDate = first_invoice_date || start_date;

      // Generate invoice code
      const [[invSeq]] = await pool.execute(
        'SELECT id, seq_next, pattern FROM sequence WHERE org_id = ? AND `key` = ? FOR UPDATE',
        [orgId, 'invoice_code']
      );
      let invoiceCode = 'INV-' + Date.now();
      if (invSeq) {
        invoiceCode = invSeq.pattern
          .replace(/\{d,(\w+)\}/g, () => {
            const now = new Date();
            return now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
          })
          .replace(/\{#,(\d+)\}/, (_, pad) => String(invSeq.seq_next).padStart(parseInt(pad), '0'));
        await pool.execute('UPDATE sequence SET seq_next = seq_next + 1 WHERE id = ?', [invSeq.id]);
      }

      // Get property_id from unit
      const [[unitRow]] = await pool.execute('SELECT property_id FROM unit WHERE id = ?', [unit_id]);
      const propertyId = unitRow ? unitRow.property_id : null;

      const invoiceId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

      await pool.execute(
        `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
          invoice_code, amount, due_on, status, category, currency_id, type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NOW())`,
        [invoiceId.toString(), orgId, tenant_id, unit_id, leaseId.toString(), propertyId,
         invoiceCode, invoiceAmount, invoiceDate, currencyId]
      );
    }

    // Mark past invoices as paid if requested
    if (mark_past_paid && start_date) {
      await pool.execute(
        `UPDATE invoice SET status = 1, updated_at = NOW()
         WHERE org_id = ? AND unit_id = ? AND tenant_id = ? AND due_on < ? AND status = 0`,
        [orgId, unit_id, tenant_id, new Date().toISOString().split('T')[0]]
      );
    }

    res.json({ code: 200, message: 'Lease created', data: { id: leaseId.toString(), lease_no: leaseNo } });
  } catch (error) {
    console.error('Create lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create lease' });
  }
});

// PUT /api/leasing/:id - Update lease
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date, rent_amount, deposit_amount, invoice_schedule, status } = req.body;
    
    await pool.execute(
      'UPDATE leasing SET start_date = ?, end_date = ?, amount = ?, deposit = ?, invoicing = ?, status = ?, updated_at = NOW() WHERE id = ?',
      [start_date, end_date, rent_amount, deposit_amount, invoice_schedule, status, id]
    );
    res.json({ code: 200, message: 'Lease updated' });
  } catch (error) {
    console.error('Update lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update lease' });
  }
});

// DELETE /api/leasing/:id - Delete lease
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [leases] = await pool.execute('SELECT unit_id FROM leasing WHERE id = ?', [id]);
    if (leases.length > 0) {
      await pool.execute('UPDATE unit SET status = 0 WHERE id = ?', [leases[0].unit_id]);
    }
    await pool.execute('UPDATE leasing SET deleted_at = NOW() WHERE id = ?', [id]);
    res.json({ code: 200, message: 'Lease deleted' });
  } catch (error) {
    console.error('Delete lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete lease' });
  }
});

// GET /api/leasing/tenant/list - Get all tenants for leasing
router.get('/tenant/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [tenants] = await pool.execute(
      'SELECT * FROM tenant WHERE org_id = ? AND status = 1 ORDER BY first_name, last_name',
      [orgId]
    );
    res.json({ code: 200, data: tenants });
  } catch (error) {
    console.error('Get tenants error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tenants' });
  }
});

// GET /api/leasing/unit/lease/:unit_id - Get lease for unit
router.get('/unit/lease/:unit_id', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;
    const [leases] = await pool.execute(
      'SELECT l.*, t.first_name, t.last_name, t.email, t.phone FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.status = 1',
      [unit_id]
    );
    res.json({ code: 200, data: leases });
  } catch (error) {
    console.error('Get unit lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get lease' });
  }
});

// GET /api/leasing/list/expiring - Get leases expiring within 30 days
router.get('/list/expiring', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status !== undefined ? parseInt(req.query.status) : 1;

    const [leases] = await pool.execute(
      `SELECT l.*, u.name as unit_name, p.display_name as property_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              DATEDIFF(l.end_date, NOW()) as days_until_expiry
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL AND l.status = ?
         AND DATEDIFF(l.end_date, NOW()) BETWEEN 0 AND 30
       ORDER BY l.end_date ASC LIMIT ${limit} OFFSET ${offset}`,
      [orgId, status]
    );

    res.json({ code: 200, data: { content: leases, totalElements: leases.length } });
  } catch (error) {
    console.error('Get expiring leases error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get expiring leases' });
  }
});

// GET /api/leasing/sum_amount/:id - Get outstanding and paid amounts for a lease
router.get('/sum_amount/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [leases] = await pool.execute('SELECT tenant_id, unit_id FROM leasing WHERE id = ?', [id]);
    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }

    const [[sums]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 0 THEN amount ELSE 0 END), 0) as outstanding,
         COALESCE(SUM(CASE WHEN status = 1 THEN amount ELSE 0 END), 0) as paid
       FROM invoice
       WHERE org_id = ? AND tenant_id = ? AND unit_id = ?`,
      [orgId, leases[0].tenant_id, leases[0].unit_id]
    );

    res.json({ code: 200, data: sums });
  } catch (error) {
    console.error('Get lease sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get lease amounts' });
  }
});

// GET /api/leasing/invoice/schedule - Get invoice schedule options
router.get('/invoice/schedule', authenticate, async (req, res) => {
  const schedules = [
    { value: 'weekly', label: 'Weekly' },
    { value: 'bi-weekly', label: 'Bi-Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'quarterly', label: 'Quarterly' },
    { value: 'bi-annually', label: 'Bi-Annually' },
    { value: 'annually', label: 'Annually' },
  ];
  res.json({ code: 200, data: schedules });
});

// POST /api/leasing/unit - Get all units (for calendar view)
router.post('/unit', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { propertyId } = req.body || {};

    let whereClause = 'p.org_id = ? AND u.active_status = 1';
    const params = [orgId];

    if (propertyId) {
      whereClause += ' AND u.property_id = ?';
      params.push(propertyId);
    }

    const [units] = await pool.execute(
      `SELECT u.*, p.display_name as property_name FROM unit u
       LEFT JOIN property p ON u.property_id = p.id
       WHERE ` + whereClause + ` ORDER BY p.display_name, u.name`,
      params
    );

    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get units for calendar error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get units' });
  }
});

// POST /api/leasing/unit/available - Get available (unoccupied) units
router.post('/unit/available', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    const [units] = await pool.execute(
      `SELECT u.*, p.display_name as property_name FROM unit u
       LEFT JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND u.active_status = 1 AND u.status = 0
       ORDER BY p.display_name, u.name`,
      [orgId]
    );

    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get available units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get available units' });
  }
});

module.exports = router;
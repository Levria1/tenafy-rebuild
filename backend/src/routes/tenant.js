const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/tenant/contacts - List tenants with paging
// Only returns tenants who have had at least one lease
// Includes has_active_lease flag and current unit/property info
// Filters: tenantStatus (active/inactive), leaseFilter (active/inactive), leaseType (fixed/month-to-month), propertyId, unitId
router.post('/contacts', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, tenantStatus, leaseFilter, leaseType, propertyId, unitId } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 't.org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (t.first_name LIKE ? OR t.last_name LIKE ? OR t.email LIKE ? OR t.phone LIKE ?)';
      const searchParam = '%' + search + '%';
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    // Tenant Status: active = status 1, inactive = status 0
    if (tenantStatus === 'active') {
      whereClause += ' AND t.status = 1';
    } else if (tenantStatus === 'inactive') {
      whereClause += ' AND t.status = 0';
    }

    // Lease Status: 'active' = has active lease, 'inactive' = no active lease
    if (leaseFilter === 'active') {
      whereClause += ' AND al.id IS NOT NULL';
    } else if (leaseFilter === 'inactive') {
      whereClause += ' AND al.id IS NULL';
    }

    // Lease Type: 'fixed' = type 0, 'month-to-month' = type 1
    if (leaseType === 'fixed') {
      whereClause += ' AND al.type = 0';
    } else if (leaseType === 'month-to-month') {
      whereClause += ' AND al.type = 1';
    }

    // Build lease_history join — only needed when filtering by property/unit
    const hasPropertyFilter = propertyId || unitId;
    let leaseHistoryJoin = '';
    const leaseHistoryParams = [];
    if (hasPropertyFilter) {
      let leaseHistorySubquery = 'SELECT DISTINCT l_h.tenant_id FROM leasing l_h JOIN unit u_h ON l_h.unit_id = u_h.id WHERE l_h.deleted_at IS NULL';
      if (propertyId) {
        leaseHistorySubquery += ' AND u_h.property_id = ?';
        leaseHistoryParams.push(propertyId);
      }
      if (unitId) {
        leaseHistorySubquery += ' AND l_h.unit_id = ?';
        leaseHistoryParams.push(unitId);
      }
      leaseHistoryJoin = `INNER JOIN (${leaseHistorySubquery}) lease_history ON lease_history.tenant_id = t.id`;
    }

    const query = `
      SELECT t.*,
             CASE WHEN al.id IS NOT NULL THEN 1 ELSE 0 END AS has_active_lease,
             al.id AS active_lease_id,
             al.amount AS rent_amount,
             al.start_date AS lease_start,
             al.end_date AS lease_end,
             al.type AS lease_type,
             u.name AS unit_name,
             u.id AS unit_id,
             p.display_name AS property_name,
             p.id AS property_id,
             COALESCE(inv.outstanding, 0) AS outstanding_amount
      FROM tenant t
      ${leaseHistoryJoin}
      LEFT JOIN leasing al ON al.tenant_id = t.id AND al.status = 1 AND al.deleted_at IS NULL
      LEFT JOIN unit u ON al.unit_id = u.id
      LEFT JOIN property p ON u.property_id = p.id
      LEFT JOIN (
        SELECT tenant_id, SUM(amount) AS outstanding
        FROM invoice WHERE org_id = ? AND status = 0
        GROUP BY tenant_id
      ) inv ON inv.tenant_id = t.id
      WHERE ${whereClause} AND t.category = 1
      ORDER BY COALESCE(t.first_name, t.company_name, '') ASC, COALESCE(t.last_name, '') ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM tenant t
      ${leaseHistoryJoin}
      LEFT JOIN leasing al ON al.tenant_id = t.id AND al.status = 1 AND al.deleted_at IS NULL
      WHERE ${whereClause} AND t.category = 1
    `;

    const [tenants] = await pool.execute(query, [...leaseHistoryParams, orgId, ...params]);
    const [[{ total }]] = await pool.execute(countQuery, [...leaseHistoryParams, ...params]);

    res.json({ code: 200, data: { content: tenants, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List tenants error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list tenants' });
  }
});

// GET /api/tenant/tenants - Get all tenants
router.get('/tenants', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { status, exclude, leasingStatus } = req.query;

    let whereClause = 'org_id = ?';
    const params = [orgId];

    if (status !== undefined) {
      whereClause += ' AND status = ?';
      params.push(status);
    }
    if (exclude) {
      whereClause += ' AND id != ?';
      params.push(exclude);
    }

    const [tenants] = await pool.execute(
      'SELECT * FROM tenant WHERE ' + whereClause + ' ORDER BY COALESCE(first_name, company_name, \'\') ASC, COALESCE(last_name, \'\') ASC',
      params
    );
    res.json({ code: 200, data: tenants });
  } catch (error) {
    console.error('Get tenants error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tenants' });
  }
});

// GET /api/tenant/outstanding - Get tenants with outstanding invoices
// NOTE: Must be defined before /:id to prevent "outstanding" being matched as a param
router.get('/outstanding', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [tenants] = await pool.execute(
      `SELECT t.*, SUM(i.amount) as outstanding_amount
       FROM tenant t
       JOIN invoice i ON i.tenant_id = t.id
       WHERE t.org_id = ? AND i.org_id = ? AND i.status = 0
       GROUP BY t.id
       HAVING outstanding_amount > 0
       ORDER BY outstanding_amount DESC`,
      [orgId, orgId]
    );
    res.json({ code: 200, data: tenants });
  } catch (error) {
    console.error('Get outstanding tenants error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get outstanding tenants' });
  }
});

// POST /api/tenant - Create tenant
router.post('/', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, middle_name, email, secondary_email, phone, birth_date,
            company_name, type, sex, id_card, profession, budget, employer, salary,
            emergency_contact, referral, notes, status } = req.body;
    const orgId = req.user.orgId;
    const tenantId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await pool.execute(
      `INSERT INTO tenant (id, org_id, first_name, last_name, middle_name, email, secondary_email, phone,
       birth_date, company_name, type, sex, id_card, profession, budget, employer, salary,
       emergency_contact, referral, notes, status, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [tenantId, orgId, first_name || null, last_name || null, middle_name || null,
       email || null, secondary_email || null, phone || null, birth_date || null,
       company_name || null, type ?? 0, sex ?? 0, id_card || null, profession || null,
       budget || null, employer || null, salary || null, emergency_contact || null,
       referral || null, notes || null, status ?? 1]
    );
    res.json({ code: 200, message: 'Tenant created', data: { id: tenantId } });
  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create tenant' });
  }
});

// GET /api/tenant/:id - Get tenant
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [tenants] = await pool.execute(
      'SELECT * FROM tenant WHERE id = ?',
      [id]
    );
    if (tenants.length === 0) {
      return res.status(404).json({ code: 404, message: 'Tenant not found' });
    }
    res.json({ code: 200, data: tenants[0] });
  } catch (error) {
    console.error('Get tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tenant' });
  }
});

// GET /api/tenant/:id/profile - Get tenant profile
router.get('/:id/profile', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [tenants] = await pool.execute(
      'SELECT * FROM tenant WHERE id = ?',
      [id]
    );
    if (tenants.length === 0) {
      return res.status(404).json({ code: 404, message: 'Tenant not found' });
    }
    res.json({ code: 200, data: tenants[0] });
  } catch (error) {
    console.error('Get tenant profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tenant profile' });
  }
});

// PUT /api/tenant/:id/profile - Update tenant
router.put('/:id/profile', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, middle_name, email, secondary_email, phone, birth_date,
            company_name, type, sex, id_card, profession, budget, employer, salary,
            emergency_contact, referral, notes, status } = req.body;

    await pool.execute(
      `UPDATE tenant SET first_name = ?, last_name = ?, middle_name = ?, email = ?, secondary_email = ?,
       phone = ?, birth_date = ?, company_name = ?, type = ?, sex = ?, id_card = ?, profession = ?,
       budget = ?, employer = ?, salary = ?, emergency_contact = ?, referral = ?, notes = ?,
       status = ?, updated_at = NOW() WHERE id = ?`,
      [first_name || null, last_name || null, middle_name || null, email || null, secondary_email || null,
       phone || null, birth_date || null, company_name || null, type ?? 0, sex ?? 0,
       id_card || null, profession || null, budget || null, employer || null, salary || null,
       emergency_contact || null, referral || null, notes || null, status ?? 1, id]
    );
    res.json({ code: 200, message: 'Tenant updated' });
  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update tenant' });
  }
});

// DELETE /api/tenant/:id - Delete tenant
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(
      'UPDATE tenant SET status = 0 WHERE id = ?',
      [id]
    );
    res.json({ code: 200, message: 'Tenant deleted' });
  } catch (error) {
    console.error('Delete tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete tenant' });
  }
});

// Helper: calculate next invoice date from last due date + invoicing schedule
function calcNextInvoiceDate(lastDueOn, lease) {
  if (!lease.invoicing || !lease.amount || lease.status !== 1) return null;

  const inv = String(lease.invoicing).toLowerCase();
  const base = lastDueOn ? new Date(lastDueOn)
    : lease.first_invoice_date ? new Date(lease.first_invoice_date)
    : null;
  if (!base) return null;

  let next = new Date(base);

  // Map numeric or string schedule to month/day increments
  if (inv === '1' || inv === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (inv === '7' || inv === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else if (inv === '14' || inv === 'bi-weekly') {
    next.setDate(next.getDate() + 14);
  } else if (inv === '28') {
    next.setDate(next.getDate() + 28);
  } else if (inv === '30' || inv === 'monthly') {
    next.setMonth(next.getMonth() + 1);
    // Adjust to the lease's due_date (day of month) if set
    if (lease.due_date) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(lease.due_date), maxDay));
    }
  } else if (inv === '60' || inv === 'bi-monthly') {
    next.setMonth(next.getMonth() + 2);
    if (lease.due_date) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(lease.due_date), maxDay));
    }
  } else if (inv === '90' || inv === 'quarterly') {
    next.setMonth(next.getMonth() + 3);
    if (lease.due_date) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(lease.due_date), maxDay));
    }
  } else if (inv === '180' || inv === 'bi-annually') {
    next.setMonth(next.getMonth() + 6);
  } else if (inv === '365' || inv === 'annually') {
    next.setFullYear(next.getFullYear() + 1);
  } else {
    // Default: treat as monthly
    next.setMonth(next.getMonth() + 1);
  }

  // If calculated date is still in the past, keep advancing
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let safety = 0;
  while (next < now && safety < 500) {
    const prev = new Date(next);
    // Re-apply the same increment
    if (inv === '1' || inv === 'daily') { next.setDate(next.getDate() + 1); }
    else if (inv === '7' || inv === 'weekly') { next.setDate(next.getDate() + 7); }
    else if (inv === '14' || inv === 'bi-weekly') { next.setDate(next.getDate() + 14); }
    else if (inv === '28') { next.setDate(next.getDate() + 28); }
    else if (inv === '30' || inv === 'monthly') {
      next.setMonth(next.getMonth() + 1);
      if (lease.due_date) {
        const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(Number(lease.due_date), maxDay));
      }
    }
    else if (inv === '60' || inv === 'bi-monthly') { next.setMonth(next.getMonth() + 2); }
    else if (inv === '90' || inv === 'quarterly') { next.setMonth(next.getMonth() + 3); }
    else if (inv === '180' || inv === 'bi-annually') { next.setMonth(next.getMonth() + 6); }
    else if (inv === '365' || inv === 'annually') { next.setFullYear(next.getFullYear() + 1); }
    else { next.setMonth(next.getMonth() + 1); }
    safety++;
    if (next.getTime() === prev.getTime()) break; // prevent infinite loop
  }

  // Don't return a date past the lease end
  if (lease.end_date && next > new Date(lease.end_date)) return null;

  return next.toISOString().split('T')[0];
}

// GET /api/tenant/:id/leases - Get tenant leases
router.get('/:id/leases', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [leases] = await pool.execute(
      'SELECT l.*, u.name as unit_name, u.type as unit_type, p.id as property_id, p.display_name as property_name, p.street_address as property_address FROM leasing l LEFT JOIN unit u ON l.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id WHERE l.tenant_id = ? AND l.deleted_at IS NULL ORDER BY l.start_date DESC',
      [id]
    );

    // For each lease, calculate next_invoice_date and fetch additional tenants
    for (const lease of leases) {
      if (lease.status === 1 && lease.invoicing) {
        const [[lastInv]] = await pool.execute(
          'SELECT due_on FROM invoice WHERE leasing_id = ? AND deleted_at IS NULL ORDER BY due_on DESC LIMIT 1',
          [lease.id]
        );
        lease.next_invoice_date = calcNextInvoiceDate(lastInv?.due_on, lease);
      } else {
        lease.next_invoice_date = null;
      }

      const [additionalTenants] = await pool.execute(
        `SELECT t.id, t.first_name, t.last_name, t.company_name, t.type,
          CASE t.type WHEN 1 THEN t.company_name ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) END as display_name
         FROM leasing_additional_tenant lat
         LEFT JOIN tenant t ON t.id = lat.tenant_id
         WHERE lat.leasing_id = ?`,
        [lease.id]
      );
      lease.additional_tenants = additionalTenants;
    }

    res.json({ code: 200, data: leases });
  } catch (error) {
    console.error('Get tenant leases error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tenant leases' });
  }
});

// GET /api/tenant/:id/leases/sum - Get tenant lease summary
router.get('/:id/leases/sum', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [[sum]] = await pool.execute(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as active,
              SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) as expired
       FROM leasing WHERE tenant_id = ? AND deleted_at IS NULL`,
      [id]
    );
    res.json({ code: 200, data: sum });
  } catch (error) {
    console.error('Get tenant leases sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get leases sum' });
  }
});

// GET /api/tenant/:id/profile/sum - Get tenant profile summary
router.get('/:id/profile/sum', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[invoiceSums]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 0 THEN amount ELSE 0 END), 0) as outstanding,
         COALESCE(SUM(CASE WHEN status = 1 THEN amount ELSE 0 END), 0) as paid
       FROM invoice WHERE org_id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [orgId, id]
    );

    const [[leaseCount]] = await pool.execute(
      'SELECT COUNT(*) as total FROM leasing WHERE tenant_id = ? AND deleted_at IS NULL AND status = 1',
      [id]
    );

    // Deposit total: sum of invoices with a deposit category
    const [[depositSum]] = await pool.execute(
      `SELECT COALESCE(SUM(i.amount), 0) as deposits
       FROM invoice i
       JOIN category_setting cs ON i.category = cs.id
       WHERE i.org_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
         AND cs.name LIKE '%Deposit%' AND cs.name NOT LIKE '%Expense%' AND cs.name NOT LIKE '%Don%'`,
      [orgId, id]
    );

    // Credits: sum from leasing credits field
    const [[creditSum]] = await pool.execute(
      `SELECT COALESCE(SUM(CAST(credits AS DECIMAL(10,2))), 0) as credits
       FROM leasing WHERE tenant_id = ? AND deleted_at IS NULL AND credits IS NOT NULL AND credits != ''`,
      [id]
    );

    res.json({ code: 200, data: {
      ...invoiceSums,
      activeLeases: leaseCount.total,
      deposits: depositSum.deposits,
      credits: creditSum.credits,
    } });
  } catch (error) {
    console.error('Get tenant profile sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get profile sum' });
  }
});

// POST /api/tenant/:id/accounting/list - Get tenant accounting/invoice list
router.post('/:id/accounting/list', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { startDate, endDate, status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ? AND tenant_id = ?';
    const params = [orgId, id];

    if (status !== undefined && status !== null) {
      whereClause += ' AND status = ?';
      params.push(status);
    }
    if (startDate) {
      whereClause += ' AND due_on >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND due_on <= ?';
      params.push(endDate);
    }

    const [invoices] = await pool.execute(
      'SELECT * FROM invoice WHERE ' + whereClause + ' ORDER BY due_on DESC LIMIT ' + limit + ' OFFSET ' + offset + '',
      [...params]
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM invoice WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: invoices, totalElements: total } });
  } catch (error) {
    console.error('Get tenant accounting error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tenant accounting' });
  }
});

// POST /api/tenant/:id/accounting/sum - Get tenant accounting summary
router.post('/:id/accounting/sum', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { startDate, endDate } = req.body || {};

    let whereClause = 'org_id = ? AND tenant_id = ?';
    const params = [orgId, id];

    if (startDate) {
      whereClause += ' AND due_on >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND due_on <= ?';
      params.push(endDate);
    }

    const [[sums]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 0 THEN amount ELSE 0 END), 0) as outstanding,
         COALESCE(SUM(CASE WHEN status = 1 THEN amount ELSE 0 END), 0) as paid
       FROM invoice WHERE ` + whereClause,
      params
    );

    res.json({ code: 200, data: sums });
  } catch (error) {
    console.error('Get tenant accounting sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get accounting sum' });
  }
});

module.exports = router;

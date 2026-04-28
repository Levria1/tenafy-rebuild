const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');


// POST /api/tenant/contacts - List tenants with paging
// A tenant = someone who has had at least one lease (active or not)
// One contact card per tenant regardless of how many leases they have
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
      whereClause += ' AND (t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(COALESCE(t.first_name,\'\'), \' \', COALESCE(t.last_name,\'\')) LIKE ? OR t.company_name LIKE ? OR t.email LIKE ? OR t.phone LIKE ?)';
      const searchParam = '%' + search + '%';
      params.push(searchParam, searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    // Always exclude soft-deleted tenants
    whereClause += ' AND t.status != 0';

    // Tenant Status: active = has a lease where today falls within start_date..end_date (inclusive)
    // Tenant Status: inactive = no such lease
    if (tenantStatus === 'active') {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.deleted_at IS NULL AND l.start_date <= CURDATE() AND l.end_date >= CURDATE())';
    } else if (tenantStatus === 'inactive') {
      whereClause += ' AND NOT EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.deleted_at IS NULL AND l.start_date <= CURDATE() AND l.end_date >= CURDATE())';
    }

    // Lease Status: active = has a current or upcoming lease (end_date >= today OR end_date IS NULL)
    // Lease Status: inactive = no current or upcoming lease
    if (leaseFilter === 'active') {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.deleted_at IS NULL AND (l.end_date >= CURDATE() OR l.end_date IS NULL))';
    } else if (leaseFilter === 'inactive') {
      whereClause += ' AND NOT EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.deleted_at IS NULL AND (l.end_date >= CURDATE() OR l.end_date IS NULL))';
    }

    // Lease Type filter: tenant has at least one lease of this type
    if (leaseType === 'fixed') {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.type = 0 AND l.deleted_at IS NULL)';
    } else if (leaseType === 'month-to-month') {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.type = 1 AND l.deleted_at IS NULL)';
    }

    // Property/unit filter: tenant has a lease at this property/unit
    if (propertyId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l JOIN unit u ON l.unit_id = u.id WHERE l.tenant_id = t.id AND u.property_id = ? AND l.deleted_at IS NULL)';
      params.push(propertyId);
    }
    if (unitId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.unit_id = ? AND l.deleted_at IS NULL)';
      params.push(unitId);
    }

    // Show all tenants regardless of lease status

    const query = `
      SELECT t.*,
             COALESCE(inv.outstanding, 0) AS outstanding_amount
      FROM tenant t
      LEFT JOIN (
        SELECT tenant_id, SUM(amount) AS outstanding
        FROM invoice WHERE org_id = ? AND status = 0 AND deleted_at IS NULL
        GROUP BY tenant_id
      ) inv ON inv.tenant_id = t.id
      WHERE ${whereClause} AND t.category = 1
      ORDER BY COALESCE(t.first_name, t.company_name, '') ASC, COALESCE(t.last_name, '') ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM tenant t
      WHERE ${whereClause} AND t.category = 1
    `;

    const [tenants] = await req.pool.execute(query, [orgId, ...params]);
    const [[{ total }]] = await req.pool.execute(countQuery, params);

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

    const [tenants] = await req.pool.execute(
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
    const [tenants] = await req.pool.execute(
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
            emergency_contact, referral, notes, cleaning_notes, status, lead_source_id } = req.body;
    const orgId = req.user.orgId;

    // Reject duplicate primary email (case-insensitive, ignoring soft-deleted rows)
    if (email && String(email).trim()) {
      const [dup] = await req.pool.execute(
        'SELECT id FROM tenant WHERE org_id = ? AND deleted_at IS NULL AND LOWER(email) = LOWER(?) LIMIT 1',
        [orgId, String(email).trim()]
      );
      if (dup.length > 0) {
        return res.status(400).json({ code: 400, message: 'This email address is already in use' });
      }
    }

    const tenantId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await req.pool.execute(
      `INSERT INTO tenant (id, org_id, first_name, last_name, middle_name, email, secondary_email, phone,
       birth_date, company_name, type, sex, id_card, profession, budget, employer, salary,
       emergency_contact, referral, notes, cleaning_notes, status, lead_source_id, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [tenantId, orgId, first_name || null, last_name || null, middle_name || null,
       email || null, secondary_email || null, phone || null, birth_date || null,
       company_name || null, type ?? 0, sex ?? 0, id_card || null, profession || null,
       budget || null, employer || null, salary || null, emergency_contact || null,
       referral || null, notes || null, cleaning_notes || null, status ?? 1, lead_source_id ?? null]
    );
    await logActivity(req, 'CREATE', 'tenant', tenantId, 'Created tenant ' + [first_name, last_name].filter(Boolean).join(' '));
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
    const [tenants] = await req.pool.execute(
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
    const [tenants] = await req.pool.execute(
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
            emergency_contact, referral, notes, cleaning_notes, status, lead_source_id } = req.body;

    await req.pool.execute(
      `UPDATE tenant SET first_name = ?, last_name = ?, middle_name = ?, email = ?, secondary_email = ?,
       phone = ?, birth_date = ?, company_name = ?, type = ?, sex = ?, id_card = ?, profession = ?,
       budget = ?, employer = ?, salary = ?, emergency_contact = ?, referral = ?, notes = ?,
       cleaning_notes = ?, status = ?, lead_source_id = ?, updated_at = NOW() WHERE id = ?`,
      [first_name || null, last_name || null, middle_name || null, email || null, secondary_email || null,
       phone || null, birth_date || null, company_name || null, type ?? 0, sex ?? 0,
       id_card || null, profession || null, budget || null, employer || null, salary || null,
       emergency_contact || null, referral || null, notes || null, cleaning_notes || null, status ?? 1, lead_source_id ?? null, id]
    );
    await logActivity(req, 'UPDATE', 'tenant', id, 'Updated tenant ' + [first_name, last_name].filter(Boolean).join(' '));
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
    const orgId = req.user.orgId;

    // Check for linked invoices
    const [[{ invoiceCount }]] = await req.pool.execute(
      'SELECT COUNT(*) as invoiceCount FROM invoice WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (Number(invoiceCount) > 0) {
      return res.status(400).json({ code: 400, message: `Cannot delete this contact — they have ${invoiceCount} invoice(s) linked. Remove or reassign them first.` });
    }

    // Check for linked leases
    const [[{ leaseCount }]] = await req.pool.execute(
      'SELECT COUNT(*) as leaseCount FROM leasing WHERE tenant_id = ? AND deleted_at IS NULL',
      [id]
    );
    if (Number(leaseCount) > 0) {
      return res.status(400).json({ code: 400, message: `Cannot delete this contact — they have ${leaseCount} lease(s) linked. Remove or reassign them first.` });
    }

    // Check for linked accounting transactions (inflow/outflow)
    const [[{ acctCount }]] = await req.pool.execute(
      'SELECT COUNT(*) as acctCount FROM accounting WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (Number(acctCount) > 0) {
      return res.status(400).json({ code: 400, message: `Cannot delete this contact — they have ${acctCount} accounting transaction(s) linked. Remove or reassign them first.` });
    }

    const [result] = await req.pool.execute(
      'UPDATE tenant SET status = 0 WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    if (result.affectedRows === 0) {
      console.warn(`[Tenant Delete] No rows affected — id=${id}, orgId=${orgId}`);
      return res.status(404).json({ code: 404, message: 'Contact not found or already deleted' });
    }
    await logActivity(req, 'DELETE', 'tenant', id, 'Deleted tenant ' + id);
    res.json({ code: 200, message: 'Contact deleted' });
  } catch (error) {
    console.error('Delete tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete contact' });
  }
});

// Helper: calculate next invoice date from last due date + invoicing schedule
function calcNextInvoiceDate(lastDueOn, lease) {
  if (!lease.invoicing || !lease.amount) return null;

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
    const [leases] = await req.pool.execute(
      'SELECT l.*, u.name as unit_name, u.type as unit_type, p.id as property_id, p.display_name as property_name, p.street_address as property_address FROM leasing l LEFT JOIN unit u ON l.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id WHERE l.tenant_id = ? AND l.deleted_at IS NULL ORDER BY l.start_date DESC',
      [id]
    );

    // For each lease, compute date-based status and calculate next_invoice_date
    const today = new Date().toISOString().split('T')[0];
    for (const lease of leases) {
      // Compute lease status purely from dates (same logic as leasing.js)
      const start = lease.start_date ? (typeof lease.start_date === 'string' ? lease.start_date.slice(0, 10) : new Date(lease.start_date).toISOString().split('T')[0]) : null;
      const end = lease.end_date ? (typeof lease.end_date === 'string' ? lease.end_date.slice(0, 10) : new Date(lease.end_date).toISOString().split('T')[0]) : null;
      if (start && start > today) lease.lease_status = 2; // upcoming
      else if (end && end < today) lease.lease_status = 0; // inactive/past
      else lease.lease_status = 1; // active

      if (lease.lease_status === 1 && lease.invoicing) {
        const [[lastInv]] = await req.pool.execute(
          'SELECT due_on FROM invoice WHERE leasing_id = ? AND deleted_at IS NULL ORDER BY due_on DESC LIMIT 1',
          [lease.id]
        );
        lease.next_invoice_date = calcNextInvoiceDate(lastInv?.due_on, lease);
      } else {
        lease.next_invoice_date = null;
      }

      const [additionalTenants] = await req.pool.execute(
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
    const [[sum]] = await req.pool.execute(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN start_date > CURDATE() THEN 0
                       WHEN end_date IS NOT NULL AND end_date < CURDATE() THEN 0
                       ELSE 1 END) as active,
              SUM(CASE WHEN end_date IS NOT NULL AND end_date < CURDATE() THEN 1
                       ELSE 0 END) as expired
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

    // Calculate outstanding and paid using actual payment data from accounting_line
    const [[invoiceSums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(
           CASE WHEN i.status != 1 THEN
             GREATEST(i.amount - COALESCE((
               SELECT SUM(al.amount) FROM accounting_line al
               JOIN accounting a ON al.accounting_id = a.id
               WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id
                 AND a.deleted_at IS NULL AND al.deleted_at IS NULL
             ), 0), 0)
           ELSE 0 END
         ), 0) as outstanding,
         COALESCE(SUM(
           COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al
             JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id
               AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0)
         ), 0) as paid
       FROM invoice i WHERE i.org_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL`,
      [orgId, id]
    );

    const [[leaseCount]] = await req.pool.execute(
      'SELECT COUNT(*) as total FROM leasing WHERE tenant_id = ? AND deleted_at IS NULL',
      [id]
    );

    // Deposit total: payments received on deposit invoices minus deposit refunds paid out
    const [[depositSum]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN i.type = 0 THEN
           COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al
             JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id
               AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0)
         ELSE 0 END), 0)
         -
         COALESCE(SUM(CASE WHEN i.type = 1 THEN
           COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al
             JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id
               AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0)
         ELSE 0 END), 0)
         as deposits
       FROM invoice i
       JOIN category_setting cs ON i.category = cs.id
       WHERE i.org_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
         AND cs.name LIKE '%Deposit%' AND cs.name NOT LIKE '%Expense%' AND cs.name NOT LIKE '%Don%'`,
      [orgId, id]
    );

    // Credits: sum from leasing credits field
    const [[creditSum]] = await req.pool.execute(
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

    let whereClause = 'i.org_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL';
    const params = [orgId, id];

    if (status !== undefined && status !== null) {
      whereClause += ' AND i.status = ?';
      params.push(status);
    }
    if (startDate) {
      whereClause += ' AND i.due_on >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND i.due_on <= ?';
      params.push(endDate);
    }

    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name as category_name,
              p.display_name as property_name, p.currency as property_currency,
              u.name as unit_name,
              l.lease_no,
              t.first_name as tenant_first_name, t.middle_name as tenant_middle_name,
              t.last_name as tenant_last_name, t.company_name as tenant_company_name,
              t.type as tenant_type,
              COALESCE((
                SELECT SUM(al.amount)
                FROM accounting_line al
                JOIN accounting a ON al.accounting_id = a.id
                WHERE al.invoice_code = i.invoice_code AND a.deleted_at IS NULL
              ), 0) as amount_paid
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN property p ON i.property_id = p.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       LEFT JOIN tenant t ON i.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY i.due_on DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) as total FROM invoice i WHERE ${whereClause}`,
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

    let whereClause = 'i.org_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL';
    const params = [orgId, id];

    if (startDate) {
      whereClause += ' AND i.due_on >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND i.due_on <= ?';
      params.push(endDate);
    }

    // Use actual payment data from accounting_line for accurate outstanding/paid
    const [[sums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN i.status != 1 AND i.type = 1 THEN
           GREATEST(i.amount - COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0), 0)
         ELSE 0 END), 0) as outstanding_outflow,
         COALESCE(SUM(CASE WHEN i.status != 1 AND (i.type = 0 OR i.type IS NULL) THEN
           GREATEST(i.amount - COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0), 0)
         ELSE 0 END), 0) as outstanding_inflow,
         COALESCE(SUM(
           COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0)
         ), 0) as paid
       FROM invoice i WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: sums });
  } catch (error) {
    console.error('Get tenant accounting sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get accounting sum' });
  }
});

module.exports = router;

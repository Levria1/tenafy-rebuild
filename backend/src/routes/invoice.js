const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const { generateInvoiceCode } = require('../utils/sequenceCode');
const { computeRentInvoiceAmount, inclusiveDays } = require('../utils/rentProrata');
const { advanceInvoiceDate, periodEndFor } = require('../utils/invoiceSchedule');
const { generateInvoicePdfBuffer } = require('./pdf');
const { sendTemplateEmail } = require('../services/emailService');
const { sendMail, sendMailWithAccount } = require('../config/mailer');

// Internal helper used by both /publish and /publish-preview to figure out the
// authoritative amount for a given lease + due_date. Returns:
//   { amount, prorated, days, periodStart, periodEnd, error }
// where `error` is set with a message if the period is invalid (e.g. lease ended).
async function resolvePublishAmount(pool, { leasing_id, due_date, fallbackAmount }) {
  const [[lease]] = await pool.execute(
    'SELECT amount, invoicing, due_date AS due_day, end_date FROM leasing WHERE id = ? AND deleted_at IS NULL',
    [leasing_id]
  );
  if (!lease) return { error: 'Lease not found' };

  const fullRent = Number(lease.amount) || Number(fallbackAmount) || 0;
  const periodStart = new Date(due_date);

  // Open-ended lease OR no invoicing schedule → can't prorate, use full rent
  if (!lease.end_date || !lease.invoicing) {
    return { amount: fullRent, prorated: false, days: null, periodStart, periodEnd: null };
  }

  const periodEnd = periodEndFor(periodStart, lease.invoicing, lease.due_day);
  const prorated = computeRentInvoiceAmount({
    rent: fullRent,
    invoicing: lease.invoicing,
    periodStart,
    periodEnd,
    leaseEnd: lease.end_date,
  });

  if (prorated === null) {
    return { error: 'Lease has already ended before this period — no invoice should be published', periodStart, periodEnd };
  }

  // Was this period actually shortened? Compare against fullRent.
  const wasProrated = Math.round(prorated * 100) !== Math.round(fullRent * 100);
  const days = wasProrated
    ? inclusiveDays(periodStart, new Date(lease.end_date))
    : null;

  return { amount: prorated, prorated: wasProrated, days, periodStart, periodEnd };
}

// POST /api/invoice/invoices - List invoices with paging
router.post('/invoices', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, searchFields, status, tenantId, propertyId, unitId, startDate, endDate, type, tenantStatus, category, leasing_id, bookingPlatformId, salesAgentId } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Server-side sorting — whitelist of allowed sort columns
    const sortFieldMap = {
      'status': 'i.status',
      'due_on': 'i.due_on',
      'dueOn': 'i.due_on',
      'contact': 'tenant_first_name',
      'tenantName': 'tenant_first_name',
      'property_unit': 'property_name',
      'propertyUnit': 'property_name',
      'amount': 'i.amount',
      'outstanding': 'outstanding',
      'days_late': 'days_late',
      'lease_booking_platform': 'lbp.name',
    };
    const sortBy = req.query.sort || req.body.sort;
    const sortOrder = (req.query.order || req.body.order || '').toLowerCase() === 'ascend' ? 'ASC' : 'DESC';
    const sortColumn = sortFieldMap[sortBy] || 'i.due_on';
    const orderClause = `${sortColumn} ${sortBy ? sortOrder : 'DESC'}`;

    let whereClause = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      const s = '%' + search + '%';
      // If specific search fields are provided, search only those columns
      if (searchFields && Array.isArray(searchFields) && searchFields.length > 0) {
        const conditions = [];
        for (const field of searchFields) {
          switch (field) {
            case 'tenantName':
              conditions.push('(t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(t.first_name, " ", t.last_name) LIKE ? OR t.company_name LIKE ?)');
              params.push(s, s, s, s);
              break;
            case 'propertyUnit':
              conditions.push('(p.display_name LIKE ? OR u.name LIKE ?)');
              params.push(s, s);
              break;
            case 'category':
              conditions.push('cs.name LIKE ?');
              params.push(s);
              break;
            case 'note':
              conditions.push('i.note LIKE ?');
              params.push(s);
              break;
            case 'invoice':
              conditions.push('i.invoice_code LIKE ?');
              params.push(s);
              break;
          }
        }
        if (conditions.length > 0) {
          whereClause += ' AND (' + conditions.join(' OR ') + ')';
        }
      } else {
        // Default: search all searchable fields
        whereClause += ' AND (i.invoice_code LIKE ? OR i.note LIKE ? OR t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(t.first_name, " ", t.last_name) LIKE ? OR t.company_name LIKE ? OR p.display_name LIKE ? OR u.name LIKE ? OR cs.name LIKE ?)';
        params.push(s, s, s, s, s, s, s, s, s);
      }
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND i.status = ?';
      params.push(status);
    }
    if (type !== undefined && type !== null) {
      whereClause += ' AND i.type = ?';
      params.push(type);
    }
    if (tenantId) {
      whereClause += ' AND i.tenant_id = ?';
      params.push(tenantId);
    }
    if (tenantStatus !== undefined && tenantStatus !== null) {
      whereClause += ' AND t.status = ?';
      params.push(tenantStatus);
    }
    if (category) {
      whereClause += ' AND i.category = ?';
      params.push(category);
    }
    if (propertyId) {
      whereClause += ' AND (p.id = ? OR u.property_id = ?)';
      params.push(propertyId, propertyId);
    }
    if (unitId) {
      whereClause += ' AND i.unit_id = ?';
      params.push(unitId);
    }
    if (leasing_id) {
      whereClause += ' AND i.leasing_id = ?';
      params.push(leasing_id);
    }
    if (bookingPlatformId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing lf WHERE lf.id = i.leasing_id AND lf.booking_platform_id = ?)';
      params.push(bookingPlatformId);
    }
    if (salesAgentId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing lf WHERE lf.id = i.leasing_id AND lf.sales_agent_id = ?)';
      params.push(salesAgentId);
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
      `SELECT i.*, t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              p.display_name as property_name, u.name as unit_name, cs.name as category_name,
              bp.name as booking_platform_name, sa.name as sales_agent_name,
              lbp.name as lease_booking_platform_name,
              lsa.name as lease_sales_agent_name,
              COALESCE(paid.total_paid, 0) as amount_paid,
              CASE i.status
                WHEN 1 THEN 0
                ELSE IF(i.amount IS NULL, 0, i.amount - COALESCE(paid.total_paid, 0))
              END as outstanding,
              CASE i.status
                WHEN 2 THEN IF(i.due_on IS NULL, 0, IF(DATEDIFF(CURRENT_TIMESTAMP, i.due_on) >= 0, DATEDIFF(CURRENT_TIMESTAMP, i.due_on), 0))
                ELSE 0
              END as days_late
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN booking_platform bp ON i.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON i.sales_agent_id = sa.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       LEFT JOIN booking_platform lbp ON l.booking_platform_id = lbp.id
       LEFT JOIN sales_agent lsa ON l.sales_agent_id = lsa.id
       LEFT JOIN (
         SELECT al.invoice_code, a.org_id, SUM(al.amount) as total_paid
         FROM accounting_line al
         JOIN accounting a ON al.accounting_id = a.id
         WHERE a.deleted_at IS NULL AND al.deleted_at IS NULL
         GROUP BY al.invoice_code, a.org_id
       ) paid ON paid.invoice_code = i.invoice_code AND paid.org_id = i.org_id
       WHERE ${whereClause}
       ORDER BY ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) as total FROM invoice i LEFT JOIN tenant t ON i.tenant_id = t.id LEFT JOIN unit u ON i.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id WHERE ${whereClause}`,
      params
    );

    // Calculate summary: outstanding outflow, outstanding inflow, paid
    const summaryWhere = whereClause.replace(/i\.status = \?/g, 'i.status IN (0,1,2)');
    const summaryParams = params.filter((_, idx) => {
      // Remove the status param if it was added
      return true;
    });
    const [[sums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN i.status IN (0,2) AND i.type = 1 THEN i.amount ELSE 0 END), 0) as outstanding_outflow,
         COALESCE(SUM(CASE WHEN i.status IN (0,2) AND i.type != 1 THEN i.amount ELSE 0 END), 0) as outstanding_inflow,
         COALESCE(SUM(CASE WHEN i.status = 1 THEN i.amount ELSE 0 END), 0) as paid
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE ${whereClause}`,
      params
    );

    res.json({
      code: 200,
      data: {
        content: invoices,
        totalElements: total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        summary: sums
      }
    });
  } catch (error) {
    console.error('List invoices error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list invoices' });
  }
});

// POST /api/invoice - Create invoice
router.post('/', authenticate, requirePermission('LANDLORD/INVOICE_CREATE'), async (req, res) => {
  try {
    const { tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_date, status, category, currency_id, type, tag_id, booking_platform_id, sales_agent_id } = req.body;
    const orgId = req.user.orgId;

    // Generate Snowflake ID
    const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    // Auto-generate invoice_code from sequence if not provided
    // Uses helper that skips codes with orphaned accounting_line records
    let code = invoice_code;
    if (!code) {
      code = await generateInvoiceCode(req.pool, orgId);
    }

    // Look up default category if not provided (use first enabled category)
    let catId = category;
    if (!catId) {
      const [[defCat]] = await req.pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 ORDER BY id LIMIT 1",
        [orgId]
      );
      catId = defCat ? defCat.id : 0;
    }

    // Get default currency_id if not provided
    let currId = currency_id;
    if (!currId) {
      const [[cur]] = await req.pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      currId = cur ? cur.id : null;
    }

    // Snapshot booking_platform / sales_agent from the parent lease when the
    // caller didn't supply them — so every invoice carries its own copy and we
    // never need a runtime fallback to the lease.
    let platformId = booking_platform_id || null;
    let agentId = sales_agent_id || null;
    if (leasing_id && (!platformId || !agentId)) {
      const [[leaseRow]] = await req.pool.execute(
        'SELECT booking_platform_id, sales_agent_id FROM leasing WHERE id = ? LIMIT 1',
        [leasing_id]
      );
      if (leaseRow) {
        if (!platformId) platformId = leaseRow.booking_platform_id || null;
        if (!agentId) agentId = leaseRow.sales_agent_id || null;
      }
    }

    await req.pool.execute(
      'INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_on, status, category, currency_id, type, tag_id, booking_platform_id, sales_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [invoiceId, orgId, tenant_id, unit_id || null, leasing_id || null, property_id || null, code, amount, note || null, due_date, status || 0, catId, currId, type || 0, tag_id || null, platformId, agentId]
    );
    await logActivity(req, 'CREATE', 'invoice', invoiceId, 'Created invoice ' + (code || invoiceId));
    res.json({ code: 200, message: 'Invoice created', data: { id: invoiceId, invoice_code: code } });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create invoice' });
  }
});

// GET /api/invoice/publish-preview?leasing_id=X&due_date=YYYY-MM-DD
// Returns the authoritative amount that /publish would write, plus prorata
// metadata so the UI can show "Publish $5,520 (prorated, 10 days)" before click.
router.get('/publish-preview', authenticate, async (req, res) => {
  try {
    const { leasing_id, due_date } = req.query;
    if (!leasing_id || !due_date) {
      return res.status(400).json({ code: 400, message: 'leasing_id and due_date are required' });
    }
    const result = await resolvePublishAmount(req.pool, { leasing_id, due_date });
    if (result.error) {
      return res.status(400).json({ code: 400, message: result.error });
    }
    res.json({
      code: 200,
      data: {
        amount: result.amount,
        prorated: result.prorated,
        days: result.days,
        period_start: result.periodStart ? result.periodStart.toISOString().slice(0, 10) : null,
        period_end: result.periodEnd ? result.periodEnd.toISOString().slice(0, 10) : null,
      },
    });
  } catch (err) {
    console.error('Publish preview error:', err);
    res.status(500).json({ code: 500, message: 'Failed to compute preview' });
  }
});

// POST /api/invoice/publish - Publish next invoice for a lease
// Creates the next invoice based on the lease's schedule and next_invoice_date.
// The amount is recomputed server-side via rentProrata so a manual click matches
// the scheduler's behavior exactly (final period gets prorated when lease ends mid-cycle).
router.post('/publish', authenticate, requirePermission('LANDLORD/INVOICE_CREATE'), async (req, res) => {
  try {
    const { tenant_id, unit_id, leasing_id, property_id, amount, due_date, category, currency_id, type, tag_id } = req.body;
    const orgId = req.user.orgId;

    if (!leasing_id || !due_date) {
      return res.status(400).json({ code: 400, message: 'leasing_id and due_date are required' });
    }

    // Check for duplicate: don't create if invoice already exists for this lease + due date
    const [[existing]] = await req.pool.execute(
      'SELECT id FROM invoice WHERE leasing_id = ? AND due_on = ? AND org_id = ? AND deleted_at IS NULL',
      [leasing_id, due_date, orgId]
    );
    if (existing) {
      return res.status(409).json({ code: 409, message: 'Invoice already exists for this date' });
    }

    // Server-side authoritative amount (handles end-of-lease prorata).
    // Falls back to client-supplied `amount` when the lease has no invoicing schedule
    // or no end_date — i.e. when prorata cannot apply.
    const resolved = await resolvePublishAmount(req.pool, {
      leasing_id, due_date, fallbackAmount: amount,
    });
    if (resolved.error) {
      return res.status(400).json({ code: 400, message: resolved.error });
    }
    const finalAmount = resolved.amount;

    // Generate Snowflake ID
    const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    // Auto-generate invoice_code — skips codes with orphaned accounting_line records
    const code = await generateInvoiceCode(req.pool, orgId);

    // Resolve category: the publish button always creates the next recurring RENT
    // invoice, so it must always be "Rental Income" — never copy the category from
    // the most recent invoice (which could be a deposit/utility/other charge and
    // would wrongly carry over). An explicit category in the body still wins.
    let catId = category || null;
    if (!catId) {
      const [[rentalCat]] = await req.pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND name LIKE '%Rental%' AND enabled = 1 LIMIT 1",
        [orgId]
      );
      if (rentalCat) catId = rentalCat.id;
    }

    // Resolve currency
    let currId = currency_id;
    if (!currId) {
      const [[cur]] = await req.pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      currId = cur ? cur.id : null;
    }

    // Resolve property_id from unit if not provided
    let propId = property_id || null;
    if (!propId && unit_id) {
      const [[unitRow]] = await req.pool.execute('SELECT property_id FROM unit WHERE id = ?', [unit_id]);
      if (unitRow) propId = unitRow.property_id;
    }

    // Snapshot booking_platform / sales_agent from the lease so published
    // (scheduled / recurring) invoices carry their own copy.
    let platformId = null;
    let agentId = null;
    const [[leaseRow]] = await req.pool.execute(
      'SELECT booking_platform_id, sales_agent_id FROM leasing WHERE id = ? LIMIT 1',
      [leasing_id]
    );
    if (leaseRow) {
      platformId = leaseRow.booking_platform_id || null;
      agentId = leaseRow.sales_agent_id || null;
    }

    await req.pool.execute(
      `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
        invoice_code, amount, due_on, status, category, currency_id, type, tag_id,
        booking_platform_id, sales_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NOW())`,
      [invoiceId, orgId, tenant_id, unit_id || null, leasing_id, propId,
       code, finalAmount, due_date, catId, currId, type || 0, tag_id || null,
       platformId, agentId]
    );

    res.json({
      code: 200,
      message: 'Invoice published',
      data: {
        id: invoiceId,
        invoice_code: code,
        amount: finalAmount,
        prorated: resolved.prorated,
        days: resolved.days,
      },
    });
  } catch (error) {
    console.error('Publish invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to publish invoice' });
  }
});

// POST /api/invoice/paid-outstanding - Get paid/outstanding sums
router.post('/paid-outstanding', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { startDate, endDate, tenantId } = req.body || {};

    let whereClause = 'i.org_id = ? AND i.status IN (0, 1)';
    const params = [orgId];

    if (tenantId) {
      whereClause += ' AND i.tenant_id = ?';
      params.push(tenantId);
    }
    if (startDate) {
      whereClause += ' AND i.due_on >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND i.due_on <= ?';
      params.push(endDate);
    }

    const [[{ total }]] = await req.pool.execute(
      'SELECT SUM(amount) as total FROM invoice i WHERE ' + whereClause + ' AND i.status = 1',
      params
    );
    const [[{ outstanding }]] = await req.pool.execute(
      'SELECT SUM(amount) as outstanding FROM invoice i WHERE ' + whereClause + ' AND i.status = 0',
      params
    );

    res.json({ code: 200, data: { paid: total || 0, outstanding: outstanding || 0 } });
  } catch (error) {
    console.error('Get sums error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get sums' });
  }
});

// GET /api/invoice/initialization-payer - Get payer options for invoice form
router.get('/initialization-payer', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { leaseId, unitId, propertyId } = req.query;

    let whereClause = 't.org_id = ? AND t.status IN (0, 1)';
    const params = [orgId];

    if (unitId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.unit_id = ? AND l.deleted_at IS NULL)';
      params.push(unitId);
    }
    if (leaseId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.id = ? AND l.deleted_at IS NULL)';
      params.push(leaseId);
    }

    const [tenants] = await req.pool.execute(
      'SELECT id, first_name, last_name, company_name, type, email FROM tenant t WHERE ' + whereClause + ' ORDER BY COALESCE(first_name, company_name, \'\') ASC, last_name ASC',
      params
    );

    res.json({ code: 200, data: tenants });
  } catch (error) {
    console.error('Get invoice payer error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get payers' });
  }
});

// GET /api/invoice/initialization-property - Get property options for invoice form
router.get('/initialization-property', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    const [properties] = await req.pool.execute(
      'SELECT id, display_name, street_address FROM property WHERE org_id = ? AND status = 1 ORDER BY display_name',
      [orgId]
    );

    res.json({ code: 200, data: properties });
  } catch (error) {
    console.error('Get invoice property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get properties' });
  }
});

// GET /api/invoice/initialization-leasing - Get leasing options for invoice form
router.get('/initialization-leasing', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { tenantId, unitId, propertyId } = req.query;

    let whereClause = 'p.org_id = ? AND l.deleted_at IS NULL';
    const params = [orgId];

    if (tenantId) {
      whereClause += ' AND l.tenant_id = ?';
      params.push(tenantId);
    }
    if (unitId) {
      whereClause += ' AND l.unit_id = ?';
      params.push(unitId);
    }
    if (propertyId) {
      whereClause += ' AND u.property_id = ?';
      params.push(propertyId);
    }

    const [leases] = await req.pool.execute(
      `SELECT l.id, l.lease_no, l.start_date, l.end_date, l.price,
              l.booking_platform_id, l.sales_agent_id,
              u.name as unit_name, p.display_name as property_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE ` + whereClause + ` ORDER BY l.start_date DESC`,
      params
    );

    res.json({ code: 200, data: leases });
  } catch (error) {
    console.error('Get invoice leasing error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get leases' });
  }
});

// GET /api/invoice/initialization-unit - Get unit options for invoice form
router.get('/initialization-unit', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { tenantId, leaseId, propertyId } = req.query;

    let whereClause = 'p.org_id = ? AND u.active_status = 1';
    const params = [orgId];

    if (propertyId) {
      whereClause += ' AND u.property_id = ?';
      params.push(propertyId);
    }
    if (tenantId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.tenant_id = ? AND l.deleted_at IS NULL)';
      params.push(tenantId);
    }

    const [units] = await req.pool.execute(
      `SELECT u.id, u.name, u.rent_price_min, u.property_id, p.display_name as property_name
       FROM unit u LEFT JOIN property p ON u.property_id = p.id
       WHERE ` + whereClause + ` ORDER BY p.display_name, u.name`,
      params
    );

    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get invoice unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get units' });
  }
});

// GET /api/invoice/code - Get invoice by code
router.get('/code', authenticate, async (req, res) => {
  try {
    const { invoiceCode } = req.query;
    const orgId = req.user.orgId;

    const [invoices] = await req.pool.execute(
      `SELECT i.*, t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              p.display_name as property_name, u.name as unit_name
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE i.invoice_code = ? AND i.org_id = ?`,
      [invoiceCode, orgId]
    );

    if (invoices.length === 0) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }

    res.json({ code: 200, data: invoices[0] });
  } catch (error) {
    console.error('Get invoice by code error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get invoice' });
  }
});

// GET /api/invoice/property/:unit_id - Get property by unit id
router.get('/property/:unit_id', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;

    const [result] = await req.pool.execute(
      `SELECT p.* FROM property p
       JOIN unit u ON u.property_id = p.id
       WHERE u.id = ? AND p.org_id = ?`,
      [unit_id, orgId]
    );

    res.json({ code: 200, data: result.length > 0 ? result[0] : null });
  } catch (error) {
    console.error('Get property by unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property' });
  }
});

// ---------------------------------------------------------------------------
// Write-off (uncollectable) — invoice.status 3
//
// A tenant who has moved out can leave a balance that is impossible to chase.
// Writing it off keeps the invoice visible (you can still see it is owed) but
// moves it OUT of every outstanding/overdue total: those all filter on
// status = 0 / = 2 / IN (0,2), so status 3 drops out automatically, and the
// scheduler's overdue/paid sweeps (status = 0 / IN (0,2)) skip it too.
// Reversible — restoring recomputes Open vs Overdue from due_on.
//
// NOTE: these are declared BEFORE the '/:id' routes (static before dynamic).
// ---------------------------------------------------------------------------

// Recompute a restored invoice's status from its due date + payments.
const RESTORE_STATUS_SQL = `
  CASE
    WHEN i.amount <= COALESCE((SELECT SUM(al.amount) FROM accounting_line al
           JOIN accounting a ON al.accounting_id = a.id
          WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id
            AND a.deleted_at IS NULL AND al.deleted_at IS NULL), 0) THEN 1
    WHEN i.due_on IS NOT NULL AND i.due_on < CURDATE() THEN 2
    ELSE 0
  END`;

// POST /api/invoice/write-off-bulk — write off many invoices at once
router.post('/write-off-bulk', authenticate, requirePermission('LANDLORD/INVOICE_EDIT'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { ids, reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ code: 400, message: 'ids must be a non-empty array' });
    }
    // Only Open/Overdue can be written off — never touch Paid (1) or already-written-off (3).
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await req.pool.execute(
      `UPDATE invoice SET status = 3, written_off_at = NOW(), written_off_reason = ?
        WHERE id IN (${placeholders}) AND org_id = ? AND deleted_at IS NULL AND status IN (0, 2)`,
      [reason ? String(reason).slice(0, 255) : null, ...ids, orgId]
    );
    res.json({ code: 200, data: { written_off: result.affectedRows, requested: ids.length } });
  } catch (error) {
    console.error('Bulk write-off error:', error);
    res.status(500).json({ code: 500, message: 'Failed to write off invoices' });
  }
});

// POST /api/invoice/:id/write-off — mark ONE invoice uncollectable
router.post('/:id/write-off', authenticate, requirePermission('LANDLORD/INVOICE_EDIT'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { reason } = req.body || {};
    const [result] = await req.pool.execute(
      `UPDATE invoice SET status = 3, written_off_at = NOW(), written_off_reason = ?
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND status IN (0, 2)`,
      [reason ? String(reason).slice(0, 255) : null, req.params.id, orgId]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ code: 400, message: 'Invoice not found, or it is already paid or written off' });
    }
    res.json({ code: 200, data: { id: String(req.params.id), status: 3 } });
  } catch (error) {
    console.error('Write-off error:', error);
    res.status(500).json({ code: 500, message: 'Failed to write off invoice' });
  }
});

// POST /api/invoice/:id/restore — undo a write-off (recompute Open/Overdue/Paid)
router.post('/:id/restore', authenticate, requirePermission('LANDLORD/INVOICE_EDIT'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [result] = await req.pool.execute(
      `UPDATE invoice i SET i.status = ${RESTORE_STATUS_SQL},
              i.written_off_at = NULL, i.written_off_reason = NULL
        WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL AND i.status = 3`,
      [req.params.id, orgId]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ code: 400, message: 'Invoice not found or is not written off' });
    }
    const [[row]] = await req.pool.execute(
      'SELECT status FROM invoice WHERE id = ? AND org_id = ? LIMIT 1', [req.params.id, orgId]
    );
    res.json({ code: 200, data: { id: String(req.params.id), status: row ? row.status : null } });
  } catch (error) {
    console.error('Restore invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to restore invoice' });
  }
});

// GET /api/invoice/:id - Get invoice detail
// POST /api/invoice/:id/email-to-tenant — email the invoice PDF to the tenant
router.post('/:id/email-to-tenant', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[inv]] = await req.pool.execute(
      `SELECT i.id, i.invoice_code, i.leasing_id, i.due_on, i.amount, i.status,
              i.tenant_id, i.category, i.invoice_code,
              t.email AS tenant_email, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL`,
      [id, orgId]
    );
    if (!inv) return res.status(404).json({ code: 404, message: 'Invoice not found' });
    if (!inv.tenant_email) return res.status(400).json({ code: 400, message: 'Tenant has no email on file' });

    // Compute outstanding (amount - sum of payments) to decide which template
    // applies. Overdue templates need the outstanding figure for %Overdue Amount%.
    const [[outRow]] = await req.pool.execute(
      `SELECT COALESCE(SUM(al.amount), 0) AS paid
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
      [inv.invoice_code, orgId]
    );
    const amount = parseFloat(inv.amount) || 0;
    const paid = parseFloat(outRow?.paid) || 0;
    const outstanding = Math.max(0, amount - paid);
    const todayStr = new Date().toISOString().split('T')[0];
    const dueStr = inv.due_on
      ? (inv.due_on instanceof Date ? inv.due_on.toISOString().split('T')[0] : String(inv.due_on).split('T')[0])
      : null;

    // Overdue when: explicitly status=2, OR status is Open/Overdue and past due AND outstanding > 0.
    // Fully-paid invoices (status=1 or outstanding=0) are never overdue.
    const isPaid = Number(inv.status) === 1 || outstanding <= 0;
    const isOverdue = !isPaid && (
      Number(inv.status) === 2 ||
      ([0, 2].includes(Number(inv.status)) && dueStr && dueStr < todayStr)
    );

    const pdfBuffer = await generateInvoicePdfBuffer(req.pool, id, orgId);
    const filename = `invoice-${inv.invoice_code || id}.pdf`;
    const attachments = [{ filename, content: pdfBuffer, contentType: 'application/pdf' }];

    // Pick the right template. Fallback chain on failure:
    //   Overdue-Tenant (if overdue) → Invoice-Tenant → plain email
    const primaryType = isOverdue ? 'Overdue-Tenant' : 'Invoice-Tenant';

    const trySend = async (templateType) => {
      try {
        return await sendTemplateEmail(req.pool, orgId, {
          templateType,
          leaseId: inv.leasing_id,
          invoiceId: inv.id,
          invoiceCode: inv.invoice_code,
          category: inv.category,
          dueDate: inv.due_on,
          overdueAmount: templateType === 'Overdue-Tenant' ? outstanding : undefined,
          attachments,
          toOverride: inv.tenant_email,
        });
      } catch (e) {
        console.error(`[email-to-tenant] template ${templateType} failed:`, e.message);
        return null;
      }
    };

    let result = await trySend(primaryType);
    let usedTemplate = result ? primaryType : null;

    // If the primary (Overdue) template wasn't configured or send failed,
    // fall back to the regular Invoice-Tenant template so the user still
    // gets the invoice in their inbox.
    if (!result && primaryType !== 'Invoice-Tenant') {
      result = await trySend('Invoice-Tenant');
      if (result) usedTemplate = 'Invoice-Tenant';
    }

    if (!result) {
      // No template configured (or send failed) — send a plain email with the PDF attached
      const tenantName = `${inv.tenant_first_name || ''} ${inv.tenant_last_name || ''}`.trim() || 'Tenant';
      const subject = `Invoice ${inv.invoice_code || ''}`.trim();
      const html = `<p>Hi ${tenantName},</p><p>Please find your invoice attached.</p><p>Regards,</p>`;
      await sendMail({ to: inv.tenant_email, subject, html, attachments });
      usedTemplate = 'plain';
    }

    res.json({
      code: 200,
      message: 'Invoice emailed to tenant',
      data: { to: inv.tenant_email, template: usedTemplate, was_overdue: isOverdue }
    });
  } catch (error) {
    console.error('Email invoice to tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to email invoice' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [invoices] = await req.pool.execute(
      `SELECT i.*, t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              t.company_name as tenant_company_name, t.type as tenant_type, t.email as tenant_email,
              p.display_name as property_name, p.id as property_id_resolved, p.currency as property_currency,
              u.name as unit_name, u.property_id as unit_property_id,
              cs.name as category_name,
              l.lease_no as lease_no
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       WHERE i.id = ? AND i.org_id = ?`,
      [id, orgId]
    );
    if (invoices.length === 0) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }

    // Get payment activity — find accounting records via accounting_line.invoice_code
    const inv = invoices[0];
    const [payments] = await req.pool.execute(
      `SELECT DISTINCT a.id, a.transaction_code, a.payment_date, a.amount as header_amount, a.type, a.note, a.tenant_id,
              a.payment_setting_id, a.category as header_category,
              al.amount, al.invoice_code as line_invoice_code,
              t2.first_name as contact_first_name, t2.last_name as contact_last_name,
              pms.payment_method as payment_method_name,
              COALESCE(cs2.name, cs3.name) as payment_category_name
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       LEFT JOIN tenant t2 ON a.tenant_id = t2.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN category_setting cs2 ON al.category = cs2.id
       LEFT JOIN category_setting cs3 ON a.category = cs3.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL
       ORDER BY a.payment_date DESC`,
      [inv.invoice_code, orgId]
    );

    // Calculate amount paid and outstanding from accounting_line amounts
    let amountPaid = 0;
    payments.forEach(p => {
      amountPaid += parseFloat(p.amount) || 0;
    });
    // If status = 1 (Paid), outstanding is always 0; otherwise invoice.amount - sum(payments)
    const invStatus = Number(inv.status);
    const outstanding = invStatus === 1 ? 0 : Math.max(0, (parseFloat(inv.amount) || 0) - amountPaid);

    res.json({ code: 200, data: { ...inv, payments, amount_paid: amountPaid, outstanding } });
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get invoice' });
  }
});

// PUT /api/invoice/:id - Update invoice
router.put('/:id', authenticate, requirePermission('LANDLORD/INVOICE_EDIT'), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note, due_date, status, type, category, tenant_id, property_id, unit_id, leasing_id, tag_id, booking_platform_id, sales_agent_id } = req.body;
    const orgId = req.user.orgId;

    // Verify invoice exists
    const [[existing]] = await req.pool.execute('SELECT id FROM invoice WHERE id = ? AND org_id = ?', [id, orgId]);
    if (!existing) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }

    // Build dynamic SET clause — only update fields that are provided
    // NOTE: invoice_code is intentionally NOT editable — it's the key that links
    // invoices to accounting_line payments. Changing it would orphan payments or
    // accidentally link to another invoice's payments.
    const fields = [];
    const params = [];
    if (amount !== undefined) { fields.push('amount = ?'); params.push(amount); }
    if (note !== undefined) { fields.push('note = ?'); params.push(note || null); }
    if (due_date !== undefined) { fields.push('due_on = ?'); params.push(due_date); }
    if (status !== undefined) { fields.push('status = ?'); params.push(status); }
    if (type !== undefined) { fields.push('type = ?'); params.push(type); }
    if (category !== undefined) { fields.push('category = ?'); params.push(category || null); }
    if (tenant_id !== undefined) { fields.push('tenant_id = ?'); params.push(tenant_id); }
    if (property_id !== undefined) { fields.push('property_id = ?'); params.push(property_id || null); }
    if (unit_id !== undefined) { fields.push('unit_id = ?'); params.push(unit_id || null); }
    if (leasing_id !== undefined) { fields.push('leasing_id = ?'); params.push(leasing_id || null); }
    if (tag_id !== undefined) { fields.push('tag_id = ?'); params.push(tag_id || null); }
    if (booking_platform_id !== undefined) { fields.push('booking_platform_id = ?'); params.push(booking_platform_id || null); }
    if (sales_agent_id !== undefined) { fields.push('sales_agent_id = ?'); params.push(sales_agent_id || null); }

    fields.push('updated_at = NOW()');
    params.push(id, orgId);

    await req.pool.execute(
      `UPDATE invoice SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );

    // Recalculate status based on actual payments whenever amount or due_date changes
    if (amount !== undefined || due_date !== undefined) {
      const [[inv]] = await req.pool.execute(
        'SELECT invoice_code, amount, due_on, status FROM invoice WHERE id = ? AND org_id = ?',
        [id, orgId]
      );
      if (inv && inv.invoice_code) {
        const [[{ total_paid }]] = await req.pool.execute(
          `SELECT COALESCE(SUM(al.amount), 0) as total_paid
           FROM accounting_line al
           JOIN accounting a ON al.accounting_id = a.id
           WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
          [inv.invoice_code, orgId]
        );
        const invAmount = parseFloat(inv.amount) || 0;
        const paid = parseFloat(total_paid) || 0;
        const today = new Date().toISOString().split('T')[0];
        const dueOn = inv.due_on ? new Date(inv.due_on).toISOString().split('T')[0] : null;
        const isPastDue = dueOn && today > dueOn;

        let newStatus;
        // A $0 (or negative) amount means nothing is owed — treat as Paid.
        // Same for invoices fully covered by payments.
        if (invAmount <= 0 || paid >= invAmount) {
          newStatus = 1; // Paid
        } else if (isPastDue) {
          newStatus = 2; // Overdue (past due, not fully paid)
        } else {
          newStatus = 0; // Open (includes partial — frontend handles display)
        }
        if (newStatus !== Number(inv.status)) {
          await req.pool.execute('UPDATE invoice SET status = ? WHERE id = ? AND org_id = ?', [newStatus, id, orgId]);
        }
      }
    }

    await logActivity(req, 'UPDATE', 'invoice', id, 'Updated invoice ' + id);
    res.json({ code: 200, message: 'Invoice updated' });
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update invoice' });
  }
});

// DELETE /api/invoice/:id - Soft delete invoice + cascade to accounting
router.delete('/:id', authenticate, requirePermission('LANDLORD/INVOICE_DELETE'), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Get invoice to find invoice_code for cascade
    const [rows] = await req.pool.execute(
      'SELECT id, invoice_code FROM invoice WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }
    const invoiceCode = rows[0].invoice_code;

    // Soft delete invoice
    await req.pool.execute(
      'UPDATE invoice SET deleted_at = CURRENT_TIMESTAMP() WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    // Cascade soft delete: accounting records linked by invoice_code
    if (invoiceCode) {
      await req.pool.execute(
        `UPDATE accounting SET deleted_at = CURRENT_TIMESTAMP()
         WHERE org_id = ? AND id IN (
           SELECT accounting_id FROM accounting_line WHERE invoice_code = ?
         )`,
        [orgId, invoiceCode]
      );
      await req.pool.execute(
        `UPDATE accounting_line SET deleted_at = CURRENT_TIMESTAMP()
         WHERE accounting_id IN (
           SELECT id FROM accounting WHERE org_id = ?
         ) AND invoice_code = ?`,
        [orgId, invoiceCode]
      );
    }

    await logActivity(req, 'DELETE', 'invoice', id, 'Deleted invoice ' + id);
    res.json({ code: 200, message: 'Invoice deleted' });
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete invoice' });
  }
});

module.exports = router;

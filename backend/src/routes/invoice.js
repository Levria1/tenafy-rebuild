const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const pool = require('../config/database');
const { generateInvoiceCode } = require('../utils/sequenceCode');

// POST /api/invoice/invoices - List invoices with paging
router.post('/invoices', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, searchFields, status, tenantId, propertyId, startDate, endDate, type, tenantStatus, category, leasing_id } = req.body || {};
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
    if (leasing_id) {
      whereClause += ' AND i.leasing_id = ?';
      params.push(leasing_id);
    }
    if (startDate) {
      whereClause += ' AND i.due_on >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND i.due_on <= ?';
      params.push(endDate);
    }

    const [invoices] = await pool.execute(
      `SELECT i.*, t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              p.display_name as property_name, u.name as unit_name, cs.name as category_name,
              COALESCE((SELECT SUM(al.amount)
                FROM accounting_line al
                JOIN accounting a ON al.accounting_id = a.id
                WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL AND al.deleted_at IS NULL), 0) as amount_paid,
              (CASE i.status
                WHEN 1 THEN 0
                ELSE IF(i.amount IS NULL, 0,
                  i.amount - COALESCE((SELECT SUM(al2.amount)
                    FROM accounting_line al2
                    JOIN accounting a2 ON al2.accounting_id = a2.id
                    WHERE al2.invoice_code = i.invoice_code AND a2.org_id = i.org_id AND a2.deleted_at IS NULL AND al2.deleted_at IS NULL), 0)
                )
              END) as outstanding,
              (CASE i.status
                WHEN 2 THEN IF(i.due_on IS NULL, 0, IF(DATEDIFF(CURRENT_TIMESTAMP, i.due_on) >= 0, DATEDIFF(CURRENT_TIMESTAMP, i.due_on), 0))
                ELSE 0
              END) as days_late
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN category_setting cs ON i.category = cs.id
       WHERE ${whereClause}
       ORDER BY ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM invoice i LEFT JOIN tenant t ON i.tenant_id = t.id LEFT JOIN unit u ON i.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id WHERE ${whereClause}`,
      params
    );

    // Calculate summary: outstanding outflow, outstanding inflow, paid
    const summaryWhere = whereClause.replace(/i\.status = \?/g, 'i.status IN (0,1,2)');
    const summaryParams = params.filter((_, idx) => {
      // Remove the status param if it was added
      return true;
    });
    const [[sums]] = await pool.execute(
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
router.post('/', authenticate, async (req, res) => {
  try {
    const { tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_date, status, category, currency_id, type, tag_id } = req.body;
    const orgId = req.user.orgId;

    // Generate Snowflake ID
    const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    // Auto-generate invoice_code from sequence if not provided
    // Uses helper that skips codes with orphaned accounting_line records
    let code = invoice_code;
    if (!code) {
      code = await generateInvoiceCode(orgId);
    }

    // Look up default category if not provided (use first enabled category)
    let catId = category;
    if (!catId) {
      const [[defCat]] = await pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 ORDER BY id LIMIT 1",
        [orgId]
      );
      catId = defCat ? defCat.id : 0;
    }

    // Get default currency_id if not provided
    let currId = currency_id;
    if (!currId) {
      const [[cur]] = await pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      currId = cur ? cur.id : null;
    }

    await pool.execute(
      'INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_on, status, category, currency_id, type, tag_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [invoiceId, orgId, tenant_id, unit_id || null, leasing_id || null, property_id || null, code, amount, note || null, due_date, status || 0, catId, currId, type || 0, tag_id || null]
    );
    res.json({ code: 200, message: 'Invoice created', data: { id: invoiceId, invoice_code: code } });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create invoice' });
  }
});

// POST /api/invoice/publish - Publish next invoice for a lease
// Creates the next invoice based on the lease's schedule and next_invoice_date
router.post('/publish', authenticate, async (req, res) => {
  try {
    const { tenant_id, unit_id, leasing_id, property_id, amount, due_date, category, currency_id, type, tag_id } = req.body;
    const orgId = req.user.orgId;

    if (!leasing_id || !due_date) {
      return res.status(400).json({ code: 400, message: 'leasing_id and due_date are required' });
    }

    // Check for duplicate: don't create if invoice already exists for this lease + due date
    const [[existing]] = await pool.execute(
      'SELECT id FROM invoice WHERE leasing_id = ? AND due_on = ? AND org_id = ? AND deleted_at IS NULL',
      [leasing_id, due_date, orgId]
    );
    if (existing) {
      return res.status(409).json({ code: 409, message: 'Invoice already exists for this date' });
    }

    // Generate Snowflake ID
    const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    // Auto-generate invoice_code — skips codes with orphaned accounting_line records
    const code = await generateInvoiceCode(orgId);

    // Resolve category: if not provided, copy from the most recent invoice for the same lease,
    // or fall back to the first "Rental Income" category for the org
    let catId = category || null;
    if (!catId) {
      const [[prevInv]] = await pool.execute(
        'SELECT category FROM invoice WHERE leasing_id = ? AND org_id = ? AND deleted_at IS NULL ORDER BY due_on DESC LIMIT 1',
        [leasing_id, orgId]
      );
      if (prevInv && prevInv.category) {
        catId = prevInv.category;
      } else {
        // Fall back to "Rental Income" category
        const [[rentalCat]] = await pool.execute(
          "SELECT id FROM category_setting WHERE org_id = ? AND name LIKE '%Rental%' AND enabled = 1 LIMIT 1",
          [orgId]
        );
        if (rentalCat) catId = rentalCat.id;
      }
    }

    // Resolve currency
    let currId = currency_id;
    if (!currId) {
      const [[cur]] = await pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      currId = cur ? cur.id : null;
    }

    // Resolve property_id from unit if not provided
    let propId = property_id || null;
    if (!propId && unit_id) {
      const [[unitRow]] = await pool.execute('SELECT property_id FROM unit WHERE id = ?', [unit_id]);
      if (unitRow) propId = unitRow.property_id;
    }

    await pool.execute(
      `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
        invoice_code, amount, due_on, status, category, currency_id, type, tag_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NOW())`,
      [invoiceId, orgId, tenant_id, unit_id || null, leasing_id, propId,
       code, amount, due_date, catId, currId, type || 0, tag_id || null]
    );

    res.json({ code: 200, message: 'Invoice published', data: { id: invoiceId, invoice_code: code } });
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

    const [[{ total }]] = await pool.execute(
      'SELECT SUM(amount) as total FROM invoice i WHERE ' + whereClause + ' AND i.status = 1',
      params
    );
    const [[{ outstanding }]] = await pool.execute(
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
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.unit_id = ? AND l.deleted_at IS NULL AND l.status = 1)';
      params.push(unitId);
    }
    if (leaseId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.tenant_id = t.id AND l.id = ? AND l.deleted_at IS NULL)';
      params.push(leaseId);
    }

    const [tenants] = await pool.execute(
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

    const [properties] = await pool.execute(
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

    let whereClause = 'p.org_id = ? AND l.deleted_at IS NULL AND l.status = 1';
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

    const [leases] = await pool.execute(
      `SELECT l.id, l.lease_no, l.start_date, l.end_date, l.price,
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
      whereClause += ' AND EXISTS (SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.tenant_id = ? AND l.deleted_at IS NULL AND l.status = 1)';
      params.push(tenantId);
    }

    const [units] = await pool.execute(
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

    const [invoices] = await pool.execute(
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

    const [result] = await pool.execute(
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

// GET /api/invoice/:id - Get invoice detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [invoices] = await pool.execute(
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
    const [payments] = await pool.execute(
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
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note, due_date, status, type, category, tenant_id, property_id, unit_id, leasing_id, tag_id } = req.body;
    const orgId = req.user.orgId;

    // Verify invoice exists
    const [[existing]] = await pool.execute('SELECT id FROM invoice WHERE id = ? AND org_id = ?', [id, orgId]);
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

    fields.push('updated_at = NOW()');
    params.push(id, orgId);

    await pool.execute(
      `UPDATE invoice SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );

    // Recalculate status based on actual payments whenever amount or due_date changes
    if (amount !== undefined || due_date !== undefined) {
      const [[inv]] = await pool.execute(
        'SELECT invoice_code, amount, due_on, status FROM invoice WHERE id = ? AND org_id = ?',
        [id, orgId]
      );
      if (inv && inv.invoice_code) {
        const [[{ total_paid }]] = await pool.execute(
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
        if (invAmount <= 0) {
          newStatus = 0; // Open if amount is 0 or negative
        } else if (paid >= invAmount) {
          newStatus = 1; // Paid
        } else if (isPastDue) {
          newStatus = 2; // Overdue (past due, not fully paid)
        } else {
          newStatus = 0; // Open (includes partial — frontend handles display)
        }
        if (newStatus !== Number(inv.status)) {
          await pool.execute('UPDATE invoice SET status = ? WHERE id = ? AND org_id = ?', [newStatus, id, orgId]);
        }
      }
    }

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
    const [rows] = await pool.execute(
      'SELECT id, invoice_code FROM invoice WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }
    const invoiceCode = rows[0].invoice_code;

    // Soft delete invoice
    await pool.execute(
      'UPDATE invoice SET deleted_at = CURRENT_TIMESTAMP() WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    // Cascade soft delete: accounting records linked by invoice_code
    if (invoiceCode) {
      await pool.execute(
        `UPDATE accounting SET deleted_at = CURRENT_TIMESTAMP()
         WHERE org_id = ? AND id IN (
           SELECT accounting_id FROM accounting_line WHERE invoice_code = ?
         )`,
        [orgId, invoiceCode]
      );
      await pool.execute(
        `UPDATE accounting_line SET deleted_at = CURRENT_TIMESTAMP()
         WHERE accounting_id IN (
           SELECT id FROM accounting WHERE org_id = ?
         ) AND invoice_code = ?`,
        [orgId, invoiceCode]
      );
    }

    res.json({ code: 200, message: 'Invoice deleted' });
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete invoice' });
  }
});

module.exports = router;

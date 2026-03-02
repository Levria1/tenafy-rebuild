const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/invoice/invoices - List invoices with paging
router.post('/invoices', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status, tenantId, propertyId, startDate, endDate, type, tenantStatus, category } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'i.org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (i.invoice_code LIKE ? OR i.note LIKE ? OR t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(t.first_name, " ", t.last_name) LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s, s);
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
              COALESCE((SELECT SUM(CASE WHEN a.type = 0 THEN a.amount ELSE -a.amount END)
                FROM accounting a WHERE a.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL), 0) as amount_paid
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN category_setting cs ON i.category = cs.id
       WHERE ${whereClause}
       ORDER BY i.due_on DESC LIMIT ${limit} OFFSET ${offset}`,
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

    // Get default currency_id if not provided
    let currId = currency_id;
    if (!currId) {
      const [[cur]] = await pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      currId = cur ? cur.id : null;
    }

    const [result] = await pool.execute(
      'INSERT INTO invoice (org_id, tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_on, status, category, currency_id, type, tag_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [orgId, tenant_id, unit_id, leasing_id || null, property_id || null, invoice_code, amount, note, due_date, status || 0, category || null, currId, type || 0, tag_id || null]
    );
    res.json({ code: 200, message: 'Invoice created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create invoice' });
  }
});

// POST /api/invoice/publish - Publish invoice
router.post('/publish', authenticate, async (req, res) => {
  try {
    const { tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_date, category, currency_id, type, tag_id } = req.body;
    const orgId = req.user.orgId;

    let currId = currency_id;
    if (!currId) {
      const [[cur]] = await pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      currId = cur ? cur.id : null;
    }

    const [result] = await pool.execute(
      'INSERT INTO invoice (org_id, tenant_id, unit_id, leasing_id, property_id, invoice_code, amount, note, due_on, status, category, currency_id, type, tag_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NOW())',
      [orgId, tenant_id, unit_id, leasing_id || null, property_id || null, invoice_code, amount, note, due_date, category || null, currId, type || 0, tag_id || null]
    );
    res.json({ code: 200, message: 'Invoice published', data: { id: result.insertId } });
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

    let whereClause = 't.org_id = ? AND t.status = 1';
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
      'SELECT id, first_name, last_name, email FROM tenant t WHERE ' + whereClause + ' ORDER BY first_name, last_name',
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
      `SELECT l.id, l.start_date, l.end_date, l.price,
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
      `SELECT i.*, t.first_name as tenant_first_name, t.last_name as tenant_last_name, t.email as tenant_email,
              p.display_name as property_name, u.name as unit_name, cs.name as category_name
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN category_setting cs ON i.category = cs.id
       WHERE i.id = ? AND i.org_id = ?`,
      [id, orgId]
    );
    if (invoices.length === 0) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }

    // Get payment activity (accounting records linked to this invoice)
    const inv = invoices[0];
    const [payments] = await pool.execute(
      `SELECT a.*, t2.first_name as contact_first_name, t2.last_name as contact_last_name,
              pms.payment_method as payment_method_name, cs2.name as payment_category_name
       FROM accounting a
       LEFT JOIN tenant t2 ON a.tenant_id = t2.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN category_setting cs2 ON a.category = cs2.id
       WHERE a.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL
       ORDER BY a.payment_date DESC`,
      [inv.invoice_code, orgId]
    );

    // Calculate amount paid and outstanding
    let amountPaid = 0;
    payments.forEach(p => {
      if (p.type === 0) amountPaid += parseFloat(p.amount) || 0;
      else amountPaid -= parseFloat(p.amount) || 0;
    });
    const outstanding = (parseFloat(inv.amount) || 0) - amountPaid;

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
    const { invoice_code, amount, note, due_date, status } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE invoice SET invoice_code = ?, amount = ?, note = ?, due_on = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [invoice_code, amount, note, due_date, status, id, orgId]
    );
    res.json({ code: 200, message: 'Invoice updated' });
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update invoice' });
  }
});

// DELETE /api/invoice/:id - Delete invoice
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE invoice SET status = -1 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Invoice deleted' });
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete invoice' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');

const { generateSequenceCode } = require('../utils/sequenceCode');

// Helper: recalculate invoice status after payment changes
// Finds all invoices linked to accounting_lines in the given transaction,
// then updates each invoice's status based on total payments vs amount vs due date
async function recalcInvoiceStatuses(pool, accountingId, orgId) {
  if (!orgId) {
    // Look up org_id from the accounting record itself
    const [[acct]] = await pool.execute('SELECT org_id FROM accounting WHERE id = ?', [accountingId]);
    if (!acct) return;
    orgId = acct.org_id;
  }

  // Get all distinct invoice_codes from this transaction's lines
  const [lines] = await pool.execute(
    `SELECT DISTINCT al.invoice_code
     FROM accounting_line al
     WHERE al.accounting_id = ? AND al.invoice_code IS NOT NULL AND al.invoice_code != ''`,
    [accountingId]
  );
  // Also check the header's invoice_code
  const [[header]] = await pool.execute(
    'SELECT invoice_code FROM accounting WHERE id = ?',
    [accountingId]
  );
  const codes = new Set(lines.map(l => l.invoice_code));
  if (header && header.invoice_code) codes.add(header.invoice_code);

  for (const invoiceCode of codes) {
    // Get the invoice — MUST filter by org_id to prevent cross-org collisions
    const [invoices] = await pool.execute(
      'SELECT id, amount, due_on, status FROM invoice WHERE invoice_code = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
      [invoiceCode, orgId]
    );
    if (invoices.length === 0) continue;
    const invoice = invoices[0];

    // Sum all payments for this invoice — MUST filter by org_id
    const [[{ total_paid }]] = await pool.execute(
      `SELECT COALESCE(SUM(al.amount), 0) as total_paid
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
      [invoiceCode, orgId]
    );

    const amount = parseFloat(invoice.amount) || 0;
    const paid = parseFloat(total_paid) || 0;
    const today = new Date().toISOString().split('T')[0];
    const dueOn = invoice.due_on ? new Date(invoice.due_on).toISOString().split('T')[0] : null;
    const isPastDue = dueOn && today > dueOn;

    let newStatus;
    if (paid >= amount && amount > 0) {
      newStatus = 1; // Paid
    } else if (isPastDue) {
      newStatus = 2; // Overdue (past due, not fully paid)
    } else {
      newStatus = 0; // Open
    }

    if (Number(invoice.status) !== newStatus) {
      await pool.execute('UPDATE invoice SET status = ? WHERE id = ?', [newStatus, invoice.id]);
    }
  }
}

// POST /api/accounting/accounts - List transactions with paging
router.post('/accounts', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, category, type, startDate, endDate, propertyId, unitId, account_setting_id, account_setting_ids, payment_setting_id, sortField, sortOrder } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      whereClause += ` AND (a.note LIKE ? OR a.transaction_code LIKE ? OR a.invoice_code LIKE ?
        OR t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) LIKE ?
        OR t.company_name LIKE ?)`;
      const s = '%' + search + '%';
      params.push(s, s, s, s, s, s, s);
    }
    if (category !== undefined && category !== null) {
      whereClause += ' AND a.category = ?';
      params.push(category);
    }
    if (type !== undefined && type !== null) {
      whereClause += ' AND a.type = ?';
      params.push(type);
    }
    if (propertyId) {
      whereClause += ' AND a.property_id = ?';
      params.push(propertyId);
    }
    if (unitId) {
      whereClause += ' AND a.unit_id = ?';
      params.push(unitId);
    }
    // Support both single account_setting_id and array account_setting_ids
    const acctIds = account_setting_ids || (account_setting_id ? [account_setting_id] : null);
    if (acctIds && acctIds.length > 0) {
      whereClause += ` AND a.account_setting_id IN (${acctIds.map(() => '?').join(',')})`;
      params.push(...acctIds);
    }
    if (payment_setting_id) {
      whereClause += ' AND a.payment_setting_id = ?';
      params.push(payment_setting_id);
    }
    if (startDate) {
      whereClause += ' AND a.payment_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND a.payment_date <= ?';
      params.push(endDate);
    }

    // Server-side sorting
    const sortFieldMap = {
      'payment_date': 'a.payment_date', 'contact': 't.first_name',
      'property': 'COALESCE(p.display_name, lp.display_name)',
      'account_name': 'ast.name', 'payment_method': 'pms.payment_method',
      'category_name': 'COALESCE(cs.name, lcs.name)',
      'outflow': 'CASE WHEN a.type = 1 THEN a.amount ELSE 0 END',
      'inflow': 'CASE WHEN a.type = 0 THEN a.amount ELSE 0 END',
      'note': 'a.note',
    };
    const sortCol = sortFieldMap[sortField] || 'a.payment_date';
    const sortDir = sortOrder === 'ascend' ? 'ASC' : 'DESC';

    const [accounts] = await req.pool.execute(
      `SELECT a.*,
              COALESCE(cs.name, lcs.name) as category_name,
              ldc.all_cats as line_all_categories,
              ast.name as account_name,
              COALESCE(p.display_name, lp.display_name) as property_name,
              COALESCE(u.name, lu.name) as unit_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              pms.payment_method as payment_method_name
       FROM accounting a
       LEFT JOIN (
         SELECT accounting_id, MIN(id) as first_line_id
         FROM accounting_line WHERE deleted_at IS NULL
         GROUP BY accounting_id
       ) fl ON fl.accounting_id = a.id
       LEFT JOIN accounting_line al ON al.id = fl.first_line_id
       LEFT JOIN (
         SELECT accounting_id, GROUP_CONCAT(DISTINCT category) as all_cats
         FROM accounting_line WHERE deleted_at IS NULL
         GROUP BY accounting_id
       ) ldc ON ldc.accounting_id = a.id
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN category_setting lcs ON al.category = lcs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN unit u ON a.unit_id = u.id
       LEFT JOIN unit lu ON al.unit_id = lu.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN property lp ON al.property_id = lp.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY ${sortCol} ${sortDir} LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    // Detect Multi-Category: header category + all line categories
    for (const acct of accounts) {
      if (acct.line_all_categories) {
        const lineCats = acct.line_all_categories.split(',');
        const allCats = new Set(lineCats);
        if (acct.category) allCats.add(String(acct.category));
        if (allCats.size > 1) {
          acct.category_name = 'Multi-Category';
        }
      }
    }

    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) as total FROM accounting a
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { content: accounts, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List accounts error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list transactions' });
  }
});

// POST /api/accounting/account - Create transaction
router.post('/account', authenticate, requirePermission('LANDLORD/ACCOUNTING_CREATE'), async (req, res) => {
  try {
    const {
      unit_id, property_id, tenant_id: rawTenantId, tenant_name, lease_id,
      category, account_setting_id, payment_setting_id,
      currency_id, currency_type,
      amount, note, type, payment_date, invoice_code: rawInvoiceCode, tag_id,
      lines
    } = req.body;
    const orgId = req.user.orgId;
    const invoice_code = rawInvoiceCode ? rawInvoiceCode.trim() : null;

    // Resolve tenant: if tenant_name provided (typed new name), find or create payee
    let tenant_id = rawTenantId || null;
    if (!tenant_id && tenant_name) {
      const nameNorm = tenant_name.replace(/\s+/g, '').toLowerCase();
      // Search all tenants and payees for a case-insensitive name match
      const [allTenants] = await req.pool.execute(
        `SELECT id, first_name, last_name, category FROM tenant WHERE org_id = ? AND status = 1`,
        [orgId]
      );
      const match = allTenants.find(t => {
        const full = `${t.first_name || ''}${t.last_name || ''}`.replace(/\s+/g, '').toLowerCase();
        return full === nameNorm;
      });
      if (match) {
        tenant_id = match.id;
      } else {
        // Auto-create new payee (category=2)
        const payeeId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
        await req.pool.execute(
          `INSERT INTO tenant (id, org_id, first_name, type, sex, status, category, created_at)
           VALUES (?, ?, ?, 0, 0, 1, 2, NOW())`,
          [payeeId.toString(), orgId, tenant_name]
        );
        tenant_id = payeeId.toString();
      }
    }

    // If currency_id not provided, look up the org's current currency
    let resolvedCurrencyId = currency_id || null;
    let resolvedCurrencyType = currency_type || null;
    if (!resolvedCurrencyId) {
      const [[curr]] = await req.pool.execute(
        'SELECT id, detail FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1',
        [orgId]
      );
      if (curr) {
        resolvedCurrencyId = curr.id;
        try {
          const detail = typeof curr.detail === 'string' ? JSON.parse(curr.detail) : curr.detail;
          resolvedCurrencyType = resolvedCurrencyType || detail?.code || null;
        } catch (e) { /* ignore */ }
      }
    }

    // Generate snowflake-style ID
    const accountingId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    // Generate transaction code from sequence (uses MAX of existing codes)
    const transaction_code = await generateSequenceCode(req.pool, orgId, 'transaction_code');

    // Collect valid lines (trim invoice_code on each)
    const validLines = [];
    if (lines && Array.isArray(lines) && lines.length > 0) {
      for (const line of lines) {
        const lineCategory = line.category || category || null;
        if (!lineCategory) continue;
        validLines.push({ ...line, category: lineCategory, invoice_code: line.invoice_code ? line.invoice_code.trim() : null });
      }
    }

    // Total amount: use sum of lines when lines exist, otherwise header amount
    const totalAmount = validLines.length > 0
      ? validLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
      : (Number(amount) || 0);

    await req.pool.execute(
      `INSERT INTO accounting
         (id, org_id, property_id, unit_id, tenant_id, lease_id,
          category, account_setting_id, payment_setting_id,
          currency_id, currency_type,
          amount, note, type, payment_date, invoice_code,
          transaction_code, tag_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [accountingId.toString(), orgId, property_id || null, unit_id || null, tenant_id || null, lease_id || null,
       category || null, account_setting_id || null, payment_setting_id || null,
       resolvedCurrencyId, resolvedCurrencyType,
       totalAmount, note || null, type ?? 0, payment_date || null,
       invoice_code || null, transaction_code, tag_id || null]
    );

    // Insert accounting_line entries:
    // If explicit lines provided, only insert those (no header line to avoid double-counting)
    // If no lines, insert header as the single line entry
    if (validLines.length > 0) {
      for (const line of validLines) {
        const lineId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
        await req.pool.execute(
          `INSERT INTO accounting_line
             (id, accounting_id, amount, category, invoice_code, property_id, unit_id, lease_id, tag_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [lineId.toString(), accountingId.toString(),
           line.amount || 0, line.category, line.invoice_code || null,
           line.property_id || null, line.unit_id || null, line.lease_id || null, line.tag_id || null]
        );
      }
    } else {
      const headerLineId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
      await req.pool.execute(
        `INSERT INTO accounting_line
           (id, accounting_id, amount, category, invoice_code, property_id, unit_id, lease_id, tag_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [headerLineId.toString(), accountingId.toString(),
         Number(amount) || 0, category || null, invoice_code || null,
         property_id || null, unit_id || null, lease_id || null, tag_id || null]
      );
    }

    // Recalculate invoice statuses for any linked invoices
    await recalcInvoiceStatuses(req.pool, accountingId.toString(), orgId);

    res.json({ code: 200, message: 'Transaction created', data: { id: accountingId.toString(), transaction_code } });
  } catch (error) {
    console.error('Create transaction error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create transaction' });
  }
});

// GET /api/accounting/account/:id - Get transaction detail
router.get('/account/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [rows] = await req.pool.execute(
      `SELECT a.*,
              COALESCE(a.category, al.category) as category,
              COALESCE(a.property_id, al.property_id) as property_id,
              COALESCE(a.unit_id, al.unit_id) as unit_id,
              COALESCE(a.lease_id, al.lease_id) as lease_id,
              COALESCE(cs.name, lcs.name) as category_name,
              ast.name as account_name,
              pms.payment_method as payment_method_name,
              COALESCE(p.display_name, lp.display_name) as property_name,
              COALESCE(u.name, lu.name) as unit_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name
       FROM accounting a
       LEFT JOIN (
         SELECT accounting_id, MIN(id) as first_line_id
         FROM accounting_line WHERE deleted_at IS NULL
         GROUP BY accounting_id
       ) fl ON fl.accounting_id = a.id
       LEFT JOIN accounting_line al ON al.id = fl.first_line_id
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN category_setting lcs ON al.category = lcs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN unit u ON a.unit_id = u.id
       LEFT JOIN unit lu ON al.unit_id = lu.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN property lp ON al.property_id = lp.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE a.id = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
      [id, orgId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'Transaction not found' });
    }

    // Also fetch line items
    const [lines] = await req.pool.execute(
      `SELECT al.*, cs.name as category_name,
              p.display_name as property_name, u.name as unit_name
       FROM accounting_line al
       LEFT JOIN category_setting cs ON al.category = cs.id
       LEFT JOIN property p ON al.property_id = p.id
       LEFT JOIN unit u ON al.unit_id = u.id
       WHERE al.accounting_id = ? AND al.deleted_at IS NULL`,
      [id]
    );

    res.json({ code: 200, data: { ...rows[0], lines } });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get transaction' });
  }
});

// PUT /api/accounting/account/:id - Update transaction
router.put('/account/:id', authenticate, requirePermission('LANDLORD/ACCOUNTING_EDIT'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category, account_setting_id, payment_setting_id,
      amount, note, type, payment_date, invoice_code: rawInvoiceCode, tag_id,
      tenant_id: rawTenantId, tenant_name, property_id, unit_id, lease_id, lines
    } = req.body;
    const orgId = req.user.orgId;
    const invoice_code = rawInvoiceCode ? rawInvoiceCode.trim() : null;

    // Resolve tenant: if tenant_name provided (typed new name), find or create payee
    let tenant_id = rawTenantId || null;
    if (!tenant_id && tenant_name) {
      const nameNorm = tenant_name.replace(/\s+/g, '').toLowerCase();
      const [allTenants] = await req.pool.execute(
        `SELECT id, first_name, last_name, category FROM tenant WHERE org_id = ? AND status = 1`,
        [orgId]
      );
      const match = allTenants.find(t => {
        const full = `${t.first_name || ''}${t.last_name || ''}`.replace(/\s+/g, '').toLowerCase();
        return full === nameNorm;
      });
      if (match) {
        tenant_id = match.id;
      } else {
        const payeeId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
        await req.pool.execute(
          `INSERT INTO tenant (id, org_id, first_name, type, sex, status, category, created_at)
           VALUES (?, ?, ?, 0, 0, 1, 2, NOW())`,
          [payeeId.toString(), orgId, tenant_name]
        );
        tenant_id = payeeId.toString();
      }
    }

    // Check if record exists
    const [existing] = await req.pool.execute(
      'SELECT id FROM accounting WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ code: 404, message: 'Transaction not found' });
    }

    // Collect valid lines (trim invoice_code on each)
    const validLines = [];
    if (lines && Array.isArray(lines) && lines.length > 0) {
      for (const line of lines) {
        const lineCategory = line.category || category || null;
        if (!lineCategory) continue;
        validLines.push({ ...line, category: lineCategory, invoice_code: line.invoice_code ? line.invoice_code.trim() : null });
      }
    }

    // Total amount: use sum of lines when lines exist, otherwise header amount
    const totalAmount = validLines.length > 0
      ? validLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
      : (Number(amount) || 0);

    await req.pool.execute(
      `UPDATE accounting
       SET category = ?, account_setting_id = ?, payment_setting_id = ?,
           amount = ?, note = ?, type = ?, payment_date = ?,
           invoice_code = ?, tag_id = ?, tenant_id = ?,
           property_id = ?, unit_id = ?, lease_id = ?,
           updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [category || null, account_setting_id || null, payment_setting_id || null,
       totalAmount, note || null, type ?? 0, payment_date || null,
       invoice_code || null, tag_id || null, tenant_id || null,
       property_id || null, unit_id || null, lease_id || null,
       id, orgId]
    );

    // Replace accounting lines: delete old, insert new
    await req.pool.execute(
      'DELETE FROM accounting_line WHERE accounting_id = ?',
      [id]
    );

    // If explicit lines provided, only insert those (no header line to avoid double-counting)
    // If no lines, insert header as the single line entry
    if (validLines.length > 0) {
      for (const line of validLines) {
        const lineId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
        await req.pool.execute(
          `INSERT INTO accounting_line
             (id, accounting_id, amount, category, invoice_code, property_id, unit_id, lease_id, tag_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [lineId.toString(), id,
           line.amount || 0, line.category, line.invoice_code || null,
           line.property_id || null, line.unit_id || null, line.lease_id || null, line.tag_id || null]
        );
      }
    } else {
      const headerLineId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
      await req.pool.execute(
        `INSERT INTO accounting_line
           (id, accounting_id, amount, category, invoice_code, property_id, unit_id, lease_id, tag_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [headerLineId.toString(), id,
         Number(amount) || 0, category || null, invoice_code || null,
         property_id || null, unit_id || null, lease_id || null, tag_id || null]
      );
    }

    // Recalculate invoice statuses for any linked invoices
    await recalcInvoiceStatuses(req.pool, id, orgId);

    res.json({ code: 200, message: 'Transaction updated' });
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ code: 500, message: error.sqlMessage || error.message || 'Failed to update transaction' });
  }
});

// DELETE /api/accounting/account/:id - Soft-delete transaction
router.delete('/account/:id', authenticate, requirePermission('LANDLORD/ACCOUNTING_DELETE'), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    // Get linked invoice codes BEFORE soft-deleting (so we can recalculate after)
    const [delLines] = await req.pool.execute(
      `SELECT DISTINCT al.invoice_code FROM accounting_line al
       WHERE al.accounting_id = ? AND al.invoice_code IS NOT NULL AND al.invoice_code != ''`,
      [id]
    );
    const [[delHeader]] = await req.pool.execute('SELECT invoice_code FROM accounting WHERE id = ?', [id]);
    const delCodes = new Set(delLines.map(l => l.invoice_code));
    if (delHeader && delHeader.invoice_code) delCodes.add(delHeader.invoice_code);

    await req.pool.execute(
      'UPDATE accounting SET deleted_at = NOW() WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    // Recalculate invoice statuses (now that this payment is soft-deleted)
    for (const invoiceCode of delCodes) {
      const [invoices] = await req.pool.execute(
        'SELECT id, amount, due_on, status FROM invoice WHERE invoice_code = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
        [invoiceCode, orgId]
      );
      if (invoices.length === 0) continue;
      const invoice = invoices[0];
      const [[{ total_paid }]] = await req.pool.execute(
        `SELECT COALESCE(SUM(al.amount), 0) as total_paid
         FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
         WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
        [invoiceCode, orgId]
      );
      const amt = parseFloat(invoice.amount) || 0;
      const paid = parseFloat(total_paid) || 0;
      const today = new Date().toISOString().split('T')[0];
      const dueOn = invoice.due_on ? new Date(invoice.due_on).toISOString().split('T')[0] : null;
      const isPastDue = dueOn && today > dueOn;
      let newStatus = paid >= amt && amt > 0 ? 1 : isPastDue ? 2 : 0;
      if (Number(invoice.status) !== newStatus) {
        await req.pool.execute('UPDATE invoice SET status = ? WHERE id = ?', [newStatus, invoice.id]);
      }
    }

    res.json({ code: 200, message: 'Transaction deleted' });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete transaction' });
  }
});

// POST /api/accounting/account/balance-no-filter - Account balance ignoring all filters except account selection
router.post('/account/balance-no-filter', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { account_setting_ids } = req.body || {};

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];

    if (account_setting_ids && account_setting_ids.length > 0) {
      whereClause += ` AND a.account_setting_id IN (${account_setting_ids.map(() => '?').join(',')})`;
      params.push(...account_setting_ids);
    }

    const [[sums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN a.type = 0 THEN a.amount ELSE 0 END), 0) as inflow,
         COALESCE(SUM(CASE WHEN a.type = 1 THEN a.amount ELSE 0 END), 0) as outflow
       FROM accounting a
       WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { balance: (sums.inflow || 0) - (sums.outflow || 0) } });
  } catch (error) {
    console.error('Get balance-no-filter error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get account balance' });
  }
});

// POST /api/accounting/account/inflow-outflow - Get inflow/outflow summary
router.post('/account/inflow-outflow', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { startDate, endDate, propertyId, account_setting_ids, account_setting_id, type, category, payment_setting_id, search } = req.body || {};

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      whereClause += ` AND (a.note LIKE ? OR a.transaction_code LIKE ? OR a.invoice_code LIKE ?
        OR t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) LIKE ?
        OR t.company_name LIKE ?)`;
      const s = '%' + search + '%';
      params.push(s, s, s, s, s, s, s);
    }
    if (type !== undefined && type !== null) { whereClause += ' AND a.type = ?'; params.push(type); }
    if (category !== undefined && category !== null) { whereClause += ' AND a.category = ?'; params.push(category); }
    if (payment_setting_id) { whereClause += ' AND a.payment_setting_id = ?'; params.push(payment_setting_id); }
    if (startDate) { whereClause += ' AND a.payment_date >= ?'; params.push(startDate); }
    if (endDate)   { whereClause += ' AND a.payment_date <= ?'; params.push(endDate); }
    if (propertyId){ whereClause += ' AND a.property_id = ?';  params.push(propertyId); }
    const sumAcctIds = account_setting_ids || (account_setting_id ? [account_setting_id] : null);
    if (sumAcctIds && sumAcctIds.length > 0) {
      whereClause += ` AND a.account_setting_id IN (${sumAcctIds.map(() => '?').join(',')})`;
      params.push(...sumAcctIds);
    }

    const [[sums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN a.type = 0 THEN a.amount ELSE 0 END), 0) as inflow,
         COALESCE(SUM(CASE WHEN a.type = 1 THEN a.amount ELSE 0 END), 0) as outflow
       FROM accounting a
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { ...sums, net: (sums.inflow || 0) - (sums.outflow || 0) } });
  } catch (error) {
    console.error('Get inflow-outflow error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get summary' });
  }
});

// POST /api/accounting/account/lines - Get transaction line items
router.post('/account/lines', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { startDate, endDate, category, propertyId, search, type, account_setting_id, account_setting_ids, payment_setting_id, sortField, sortOrder } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      whereClause += ` AND (a.note LIKE ? OR a.transaction_code LIKE ? OR a.invoice_code LIKE ?
        OR t.first_name LIKE ? OR t.last_name LIKE ? OR CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) LIKE ?
        OR t.company_name LIKE ?)`;
      const s = '%' + search + '%';
      params.push(s, s, s, s, s, s, s);
    }
    if (category)   { whereClause += ' AND al.category = ?';    params.push(category); }
    if (type !== undefined && type !== null) { whereClause += ' AND a.type = ?'; params.push(type); }
    const lineAcctIds = account_setting_ids || (account_setting_id ? [account_setting_id] : null);
    if (lineAcctIds && lineAcctIds.length > 0) {
      whereClause += ` AND a.account_setting_id IN (${lineAcctIds.map(() => '?').join(',')})`;
      params.push(...lineAcctIds);
    }
    if (payment_setting_id) { whereClause += ' AND a.payment_setting_id = ?'; params.push(payment_setting_id); }
    if (propertyId) { whereClause += ' AND al.property_id = ?'; params.push(propertyId); }
    if (startDate)  { whereClause += ' AND a.payment_date >= ?'; params.push(startDate); }
    if (endDate)    { whereClause += ' AND a.payment_date <= ?'; params.push(endDate); }

    // Server-side sorting
    const lineSortMap = {
      'payment_date': 'a.payment_date', 'contact': 't.first_name', 'property': 'p.display_name',
      'account_name': 'ast.name', 'payment_method': 'pms.payment_method', 'category_name': 'cs.name',
      'outflow': 'CASE WHEN a.type = 1 THEN al.amount ELSE 0 END',
      'inflow': 'CASE WHEN a.type = 0 THEN al.amount ELSE 0 END',
      'note': 'a.note',
    };
    const lineSortCol = lineSortMap[sortField] || 'a.payment_date';
    const lineSortDir = sortOrder === 'ascend' ? 'ASC' : 'DESC';

    const [lines] = await req.pool.execute(
      `SELECT al.*, a.payment_date, a.transaction_code, a.type, a.note as transaction_note,
              cs.name as category_name,
              ast.name as account_name,
              pms.payment_method as payment_method_name,
              p.display_name as property_name, u.name as unit_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       LEFT JOIN category_setting cs ON al.category = cs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN property p ON al.property_id = p.id
       LEFT JOIN unit u ON al.unit_id = u.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY ${lineSortCol} ${lineSortDir} LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) as total
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}`,
      params
    );

    // Calculate inflow/outflow sums for lines
    const [[sums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN a.type = 1 THEN al.amount ELSE 0 END), 0) as outflow,
         COALESCE(SUM(CASE WHEN a.type = 0 THEN al.amount ELSE 0 END), 0) as inflow
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE ${whereClause}`,
      params
    );

    res.json({
      code: 200,
      data: {
        content: lines,
        totalElements: total,
        summary: {
          outflow: parseFloat(sums.outflow) || 0,
          inflow: parseFloat(sums.inflow) || 0,
          net: (parseFloat(sums.inflow) || 0) - (parseFloat(sums.outflow) || 0),
        }
      }
    });
  } catch (error) {
    console.error('Get account lines error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get transaction lines' });
  }
});

// GET /api/accounting/settings/categories - Get category settings
router.get('/settings/categories', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT * FROM category_setting WHERE org_id = ? AND enabled = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get categories' });
  }
});

// GET /api/accounting/settings/accounts - Get bank account settings
router.get('/settings/accounts', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT * FROM account_setting WHERE org_id = ? AND enabled = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get account settings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get accounts' });
  }
});

// GET /api/accounting/settings/payment-methods - Get payment method settings
router.get('/settings/payment-methods', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT id, payment_method as name FROM payment_method_setting WHERE org_id = ? AND enabled = 1 ORDER BY id',
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get payment methods' });
  }
});

// GET /api/accounting/invoice/property/graph/:property_id - Monthly income graph
router.get('/invoice/property/graph/:property_id', authenticate, async (req, res) => {
  try {
    const { property_id } = req.params;
    const orgId = req.user.orgId;
    const months = parseInt(req.query.months) || 12;

    const [rows] = await req.pool.execute(
      `SELECT
         DATE_FORMAT(i.due_on, '%Y-%m') as month,
         COALESCE(SUM(CASE WHEN i.status = 1 THEN i.amount ELSE 0 END), 0) as paid,
         COALESCE(SUM(CASE WHEN i.status = 0 THEN i.amount ELSE 0 END), 0) as outstanding,
         COALESCE(SUM(i.amount), 0) as total
       FROM invoice i
       JOIN unit u ON i.unit_id = u.id
       WHERE u.property_id = ? AND i.org_id = ?
         AND i.due_on >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
         AND i.deleted_at IS NULL
       GROUP BY DATE_FORMAT(i.due_on, '%Y-%m')
       ORDER BY month ASC`,
      [property_id, orgId, months]
    );

    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Property graph error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property graph data' });
  }
});

// POST /api/accounting/owner/paid-outstanding - Owner-specific paid/outstanding summary
router.post('/owner/paid-outstanding', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { ownerId, startDate, endDate } = req.body || {};

    let whereClause = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];

    if (ownerId) { whereClause += ' AND u.owner_id = ?'; params.push(ownerId); }
    if (startDate) { whereClause += ' AND i.due_on >= ?'; params.push(startDate); }
    if (endDate)   { whereClause += ' AND i.due_on <= ?'; params.push(endDate); }

    const [[sums]] = await req.pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN i.status = 1 THEN i.amount ELSE 0 END), 0) as paid,
         COALESCE(SUM(CASE WHEN i.status = 0 THEN i.amount ELSE 0 END), 0) as outstanding
       FROM invoice i
       JOIN unit u ON i.unit_id = u.id
       WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: sums });
  } catch (error) {
    console.error('Owner paid/outstanding error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get owner summary' });
  }
});

module.exports = router;

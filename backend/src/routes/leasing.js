const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const { generateInvoiceCode, generateSequenceCode } = require('../utils/sequenceCode');
const {
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendDepositToTenant,
  sendCheckinToTenant,
  sendCheckoutToTenant,
  loadTemplate,
} = require('../services/emailService');

// Helper: advance a date by one invoice period
function advanceInvoiceDate(date, schedule, dueDay) {
  const inv = String(schedule).toLowerCase();
  const next = new Date(date);
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
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '60' || inv === 'bi-monthly') {
    next.setMonth(next.getMonth() + 2);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '90' || inv === 'quarterly') {
    next.setMonth(next.getMonth() + 3);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '180' || inv === 'bi-annually') {
    next.setMonth(next.getMonth() + 6);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '365' || inv === 'annually') {
    next.setFullYear(next.getFullYear() + 1);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else {
    next.setMonth(next.getMonth() + 1); // default monthly
  }
  return next;
}

// POST /api/leasing/list - List leases with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status, startDate, endDate, type, tenantStatus, propertyId, unitId, sortField, sortOrder } = req.body || {};
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
    if (unitId) {
      whereClause += ' AND l.unit_id = ?';
      params.push(unitId);
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

    const [leases] = await req.pool.execute(
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

    const [[{ total }]] = await req.pool.execute(
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
    const [leases] = await req.pool.execute(
      'SELECT l.*, u.name as unit_name, p.display_name as property_name, t.first_name as tenant_first_name, t.last_name as tenant_last_name, t.email as tenant_email, t.phone as tenant_phone FROM leasing l LEFT JOIN unit u ON l.unit_id = u.id LEFT JOIN property p ON u.property_id = p.id LEFT JOIN tenant t ON l.tenant_id = t.id WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL',
      [id, orgId]
    );
    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }
    const lease = leases[0];

    // Fetch additional tenants
    const [additionalTenants] = await req.pool.execute(
      `SELECT t.id, t.first_name, t.last_name, t.company_name, t.type,
        CASE t.type WHEN 1 THEN t.company_name ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) END as display_name
       FROM leasing_additional_tenant lat
       LEFT JOIN tenant t ON t.id = lat.tenant_id
       WHERE lat.leasing_id = ?`,
      [id]
    );
    lease.additional_tenants = additionalTenants;

    res.json({ code: 200, data: lease });
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
        AND l.start_date < ? AND (l.end_date > ? OR l.end_date IS NULL)`;
    const params = [unit_id, end_date || '2099-12-31', start_date];

    if (exclude_lease_id) {
      query += ' AND l.id != ?';
      params.push(exclude_lease_id);
    }

    const [conflicts] = await req.pool.execute(query, params);

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
      additionalTenantIds,
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

    // Server-side overlap check — block creation if dates conflict with an existing active lease on the same unit
    if (unit_id && start_date) {
      const overlapEnd = end_date || '2099-12-31';
      const [conflicts] = await req.pool.execute(
        `SELECT l.id, l.lease_no, l.start_date, l.end_date, t.first_name, t.last_name
         FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
         WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.status = 1
           AND l.start_date < ? AND (l.end_date > ? OR l.end_date IS NULL)`,
        [unit_id, overlapEnd, start_date]
      );
      if (conflicts.length > 0) {
        const c = conflicts[0];
        const tenantName = [c.first_name, c.last_name].filter(Boolean).join(' ');
        return res.status(400).json({
          code: 400,
          message: `Cannot create lease — overlaps with ${c.lease_no || '#' + c.id} (${tenantName}): ${c.start_date} to ${c.end_date || 'ongoing'}`
        });
      }
    }

    // Generate lease ID (snowflake-style)
    const leaseId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    // Generate lease_no from sequence (uses highest existing + 1)
    let leaseNo = lease_no || null;
    if (!leaseNo) {
      leaseNo = await generateSequenceCode(req.pool, orgId, 'leasing_code');
    }

    // Get currency
    const [[cur]] = await req.pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
    const currencyId = cur ? cur.id : null;

    await req.pool.execute(
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
    await req.pool.execute('UPDATE unit SET status = 1 WHERE id = ?', [unit_id]);

    // Invoice generation logic:
    // - If there's an amount/price: ALWAYS create at least one invoice
    // - If recurring (share_lease=1, invoicing set): generate all past invoices + next upcoming
    // - If NOT recurring: only ONE invoice ever
    // - mark_past_paid controls status of past invoices (1=paid vs 0=open)
    const invoiceAmount = amount || price;
    if (invoiceAmount && parseFloat(invoiceAmount) > 0) {
      const today = new Date().toISOString().split('T')[0];
      const todayMs = new Date(today).getTime();

      // Get property_id from unit
      const [[unitRow]] = await req.pool.execute('SELECT property_id FROM unit WHERE id = ?', [unit_id]);
      const propertyId = unitRow ? unitRow.property_id : null;

      // Look up default rent category (invoice.category is NOT NULL)
      const [[rentCat]] = await req.pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 AND name LIKE '%Rental Income%' ORDER BY id LIMIT 1",
        [orgId]
      );
      const rentCategoryId = rentCat ? rentCat.id : null;

      // Helper: create a single invoice with collision-safe code generation
      // Returns { invoiceId, invoiceCode, dueDate } for email sending
      const createOneInvoice = async (dueDate, status) => {
        const invoiceCode = await generateInvoiceCode(req.pool, orgId);
        const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
        await req.pool.execute(
          `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
            invoice_code, amount, due_on, status, category, currency_id, type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
          [invoiceId, orgId, tenant_id, unit_id, leaseId.toString(), propertyId,
           invoiceCode, invoiceAmount, dueDate, status, rentCategoryId, currencyId]
        );
        return { invoiceId, invoiceCode, dueDate };
      };

      const createdInvoices = [];
      const isRecurring = share_lease && invoicing;

      if (isRecurring) {
        // RECURRING: Generate all invoices from first_invoice_date through today + next upcoming
        const firstDate = first_invoice_date || start_date;
        const MAX_INVOICES = 500;
        let cursor = new Date(firstDate);
        let count = 0;

        while (count < MAX_INVOICES) {
          if (end_date && cursor > new Date(end_date)) break;
          const dateStr = cursor.toISOString().split('T')[0];
          const isPast = cursor.getTime() <= todayMs;

          if (isPast) {
            createdInvoices.push(await createOneInvoice(dateStr, mark_past_paid ? 1 : 0));
          } else {
            createdInvoices.push(await createOneInvoice(dateStr, 0));
            break;
          }
          cursor = advanceInvoiceDate(cursor, invoicing, due_date);
          count++;
        }
      } else {
        // NON-RECURRING: Create just ONE invoice
        const invoiceDate = first_invoice_date || start_date || today;
        const isPast = new Date(invoiceDate).getTime() <= todayMs;
        const invoiceStatus = (isPast && mark_past_paid) ? 1 : 0;
        createdInvoices.push(await createOneInvoice(invoiceDate, invoiceStatus));
      }

      // Send invoice posted emails (fire-and-forget, don't block lease creation)
      for (const inv of createdInvoices) {
        sendInvoiceToTenant(req.pool, orgId, leaseId.toString(), {
          invoiceId: inv.invoiceId, invoiceCode: inv.invoiceCode,
          category: rentCategoryId, dueDate: new Date(inv.dueDate),
        }).catch(err => console.error('[Lease] Invoice email to tenant error:', err.message));

        sendInvoiceToLandlord(req.pool, orgId, leaseId.toString(), {
          invoiceId: inv.invoiceId, invoiceCode: inv.invoiceCode,
          category: rentCategoryId, dueDate: new Date(inv.dueDate),
        }).catch(err => console.error('[Lease] Invoice email to landlord error:', err.message));
      }
    }

    // Create security deposit invoice if deposit amount > 0
    if (deposit && parseFloat(deposit) > 0) {
      // Generate collision-safe deposit invoice code
      const depInvoiceCode = await generateInvoiceCode(req.pool, orgId);

      // Get property_id from unit (may already have it from rent invoice block)
      let depPropertyId = null;
      const [[depUnitRow]] = await req.pool.execute('SELECT property_id FROM unit WHERE id = ?', [unit_id]);
      if (depUnitRow) depPropertyId = depUnitRow.property_id;

      // Look up deposit category
      const [[depCat]] = await req.pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 AND name LIKE '%Deposit%' AND name NOT LIKE '%Expense%' AND name NOT LIKE '%Don%' ORDER BY id LIMIT 1",
        [orgId]
      );
      const depositCategoryId = depCat ? depCat.id : null;

      const depInvoiceId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
      const today = new Date().toISOString().split('T')[0];

      await req.pool.execute(
        `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
          invoice_code, amount, due_on, status, category, currency_id, type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NOW())`,
        [depInvoiceId.toString(), orgId, tenant_id, unit_id, leaseId.toString(), depPropertyId,
         depInvoiceCode, deposit, today, depositCategoryId, currencyId]
      );

      // Send deposit posted email (fire-and-forget)
      sendDepositToTenant(req.pool, orgId, leaseId.toString())
        .catch(err => console.error('[Lease] Deposit email error:', err.message));
    }

    // Send check-in email if lease starts within the template's date_first window (fire-and-forget)
    if (tenant_checkin && start_date) {
      (async () => {
        try {
          const checkinTemplate = await loadTemplate(req.pool, orgId, 'Checkin-Tenant');
          const dateFirstDays = checkinTemplate ? (Number(checkinTemplate.date_first) || 0) : 0;
          const startMs = new Date(start_date).getTime();
          const todayMs2 = new Date(new Date().toISOString().split('T')[0]).getTime();
          const daysUntilStart = Math.round((startMs - todayMs2) / (1000 * 60 * 60 * 24));
          // Send if start date is today or within the date_first window
          if (daysUntilStart >= 0 && daysUntilStart <= dateFirstDays) {
            await sendCheckinToTenant(req.pool, orgId, leaseId.toString());
          }
        } catch (err) {
          console.error('[Lease] Check-in email error:', err.message);
        }
      })();
    }

    // Send check-out email if lease ends within the template's date_first window (fire-and-forget)
    if (tenant_checkout && end_date) {
      (async () => {
        try {
          const checkoutTemplate = await loadTemplate(req.pool, orgId, 'Checkout-Tenant');
          const dateFirstDays = checkoutTemplate ? (Number(checkoutTemplate.date_first) || 0) : 0;
          let beforeDate = true;
          if (checkoutTemplate && checkoutTemplate.before_date !== undefined && checkoutTemplate.before_date !== null) {
            if (Buffer.isBuffer(checkoutTemplate.before_date)) {
              beforeDate = checkoutTemplate.before_date[0] === 1;
            } else {
              beforeDate = Boolean(checkoutTemplate.before_date);
            }
          }
          // Only send at creation if before_date is true (sending before end date)
          if (beforeDate) {
            const endMs = new Date(end_date).getTime();
            const todayMs2 = new Date(new Date().toISOString().split('T')[0]).getTime();
            const daysUntilEnd = Math.round((endMs - todayMs2) / (1000 * 60 * 60 * 24));
            if (daysUntilEnd >= 0 && daysUntilEnd <= dateFirstDays) {
              await sendCheckoutToTenant(req.pool, orgId, leaseId.toString());
            }
          }
        } catch (err) {
          console.error('[Lease] Check-out email error:', err.message);
        }
      })();
    }

    // Insert additional tenants
    if (Array.isArray(additionalTenantIds) && additionalTenantIds.length > 0) {
      for (const atId of additionalTenantIds) {
        await req.pool.execute(
          'INSERT IGNORE INTO leasing_additional_tenant (leasing_id, tenant_id) VALUES (?, ?)',
          [leaseId.toString(), atId]
        );
      }
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
    const orgId = req.user.orgId;
    const {
      unit_id, tenant_id, start_date, end_date, type, price, deposit,
      due_date, invoicing, amount, contract_type, unit_information,
      note, credits, contact_phone, first_invoice_date, status,
      additionalTenantIds,
      mark_past_paid
    } = req.body;

    // Server-side overlap check on edit — check if new dates/unit conflict with other leases
    const checkUnit = unit_id || null;
    const checkStart = start_date || null;
    const checkEnd = end_date !== undefined ? (end_date || null) : undefined;
    if (checkUnit || checkStart || checkEnd !== undefined) {
      // Fetch current lease to fill in any fields not being changed
      const [[current]] = await req.pool.execute(
        'SELECT unit_id, start_date, end_date FROM leasing WHERE id = ?', [id]
      );
      if (current) {
        const effectiveUnit = checkUnit || current.unit_id;
        const effectiveStart = checkStart || current.start_date;
        const effectiveEnd = checkEnd !== undefined ? (checkEnd || '2099-12-31') : (current.end_date || '2099-12-31');
        const effectiveStartStr = typeof effectiveStart === 'string' ? effectiveStart : effectiveStart.toISOString().split('T')[0];

        const [conflicts] = await req.pool.execute(
          `SELECT l.id, l.lease_no, l.start_date, l.end_date, t.first_name, t.last_name
           FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
           WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.status = 1 AND l.id != ?
             AND l.start_date < ? AND (l.end_date > ? OR l.end_date IS NULL)`,
          [effectiveUnit, id, effectiveEnd, effectiveStartStr]
        );
        if (conflicts.length > 0) {
          const c = conflicts[0];
          const tenantName = [c.first_name, c.last_name].filter(Boolean).join(' ');
          return res.status(400).json({
            code: 400,
            message: `Cannot update lease — overlaps with ${c.lease_no || '#' + c.id} (${tenantName}): ${c.start_date} to ${c.end_date || 'ongoing'}`
          });
        }
      }
    }

    // Build dynamic SET clause
    const fields = [];
    const params = [];
    if (unit_id !== undefined) { fields.push('unit_id = ?'); params.push(unit_id); }
    if (tenant_id !== undefined) { fields.push('tenant_id = ?'); params.push(tenant_id); }
    if (start_date !== undefined) { fields.push('start_date = ?'); params.push(start_date); }
    if (end_date !== undefined) { fields.push('end_date = ?'); params.push(end_date || null); }
    if (type !== undefined) { fields.push('type = ?'); params.push(type); }
    if (price !== undefined) { fields.push('price = ?'); params.push(price); }
    if (amount !== undefined) { fields.push('amount = ?'); params.push(amount); }
    if (deposit !== undefined) { fields.push('deposit = ?'); params.push(deposit); }
    if (due_date !== undefined) { fields.push('due_date = ?'); params.push(due_date); }
    if (invoicing !== undefined) { fields.push('invoicing = ?'); params.push(invoicing); }
    if (contract_type !== undefined) { fields.push('contract_type = ?'); params.push(contract_type); }
    if (unit_information !== undefined) { fields.push('unit_information = ?'); params.push(unit_information || null); }
    if (note !== undefined) { fields.push('note = ?'); params.push(note || null); }
    if (credits !== undefined) { fields.push('credits = ?'); params.push(credits || null); }
    if (contact_phone !== undefined) { fields.push('contact_phone = ?'); params.push(contact_phone || null); }
    if (first_invoice_date !== undefined) { fields.push('first_invoice_date = ?'); params.push(first_invoice_date || null); }
    if (status !== undefined) { fields.push('status = ?'); params.push(status); }
    fields.push('updated_at = NOW()');
    params.push(id);

    if (fields.length > 1) {
      await req.pool.execute(`UPDATE leasing SET ${fields.join(', ')} WHERE id = ?`, params);
    }

    // Replace additional tenants
    if (Array.isArray(additionalTenantIds)) {
      await req.pool.execute('DELETE FROM leasing_additional_tenant WHERE leasing_id = ?', [id]);
      for (const atId of additionalTenantIds) {
        await req.pool.execute(
          'INSERT IGNORE INTO leasing_additional_tenant (leasing_id, tenant_id) VALUES (?, ?)',
          [id, atId]
        );
      }
    }

    // Mark past invoices as paid if requested
    if (mark_past_paid) {
      const today = new Date().toISOString().split('T')[0];
      await req.pool.execute(
        'UPDATE invoice SET status = 1 WHERE leasing_id = ? AND org_id = ? AND status = 0 AND due_on <= ? AND deleted_at IS NULL',
        [id, orgId, today]
      );
    }

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
    const [leases] = await req.pool.execute('SELECT unit_id FROM leasing WHERE id = ?', [id]);
    if (leases.length > 0) {
      await req.pool.execute('UPDATE unit SET status = 0 WHERE id = ?', [leases[0].unit_id]);
    }
    await req.pool.execute('DELETE FROM leasing_additional_tenant WHERE leasing_id = ?', [id]);
    await req.pool.execute('UPDATE leasing SET deleted_at = NOW() WHERE id = ?', [id]);
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
    const [tenants] = await req.pool.execute(
      'SELECT * FROM tenant WHERE org_id = ? AND status = 1 AND category = 1 ORDER BY first_name, last_name',
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
    const [leases] = await req.pool.execute(
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

    const [leases] = await req.pool.execute(
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

    const [leases] = await req.pool.execute('SELECT tenant_id, unit_id FROM leasing WHERE id = ?', [id]);
    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }

    const [[sums]] = await req.pool.execute(
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

    const [units] = await req.pool.execute(
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

    const [units] = await req.pool.execute(
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
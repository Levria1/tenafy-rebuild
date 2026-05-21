const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const { generateInvoiceCode, generateSequenceCode } = require('../utils/sequenceCode');
const { computeRentInvoiceAmount } = require('../utils/rentProrata');
const { advanceInvoiceDate } = require('../utils/invoiceSchedule');
const {
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendDepositToTenant,
  sendCheckinToTenant,
  sendCheckoutToTenant,
  loadTemplate,
} = require('../services/emailService');

// advanceInvoiceDate is imported from utils/invoiceSchedule.js (shared with scheduler.js + invoice.js)

// Helper: compute lease status purely from dates
// 0=Inactive (past end date), 1=Active (current), 2=Upcoming (future start date)
// Note: stored leasing.status column is NOT used — deleted_at handles termination
function computeLeaseStatus(lease) {
  const today = new Date().toISOString().split('T')[0];
  const start = lease.start_date ? (typeof lease.start_date === 'string' ? lease.start_date.slice(0, 10) : new Date(lease.start_date).toISOString().split('T')[0]) : null;
  const end = lease.end_date ? (typeof lease.end_date === 'string' ? lease.end_date.slice(0, 10) : new Date(lease.end_date).toISOString().split('T')[0]) : null;
  if (start && start > today) return 2; // upcoming
  if (end && end < today) return 0; // inactive/past
  return 1; // active
}

// SQL expression for computed lease status (for filtering/sorting)
// Purely date-based — stored status column is not used
const COMPUTED_STATUS_SQL = `CASE
  WHEN l.start_date > CURDATE() THEN 2
  WHEN l.end_date IS NOT NULL AND l.end_date < CURDATE() THEN 0
  ELSE 1
END`;

// POST /api/leasing/list - List leases with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status, startDate, endDate, type, tenantStatus, propertyId, unitId, bookingPlatformId, sortField, sortOrder } = req.body || {};
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
    // Filter by computed status (0=inactive, 1=active, 2=upcoming)
    if (status !== undefined && status !== null) {
      whereClause += ` AND (${COMPUTED_STATUS_SQL}) = ?`;
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
    if (bookingPlatformId) {
      whereClause += ' AND l.booking_platform_id = ?';
      params.push(bookingPlatformId);
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
      lease_no: 'l.lease_no',
      tenant: 't.first_name',
      property: 'p.display_name',
      start_date: 'l.start_date',
      end_date: 'l.end_date',
      status: `(${COMPUTED_STATUS_SQL})`,
      price: 'l.amount',
      phone: 't.phone',
    };
    let orderBy = 'l.start_date DESC';
    if (sortField && allowedSortFields[sortField]) {
      const dir = sortOrder === 'descend' ? 'DESC' : 'ASC';
      orderBy = `${allowedSortFields[sortField]} ${dir}`;
    }

    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name as unit_name, p.display_name as property_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              t.phone as tenant_phone, t.status as tenant_status,
              bp.name as booking_platform_name, sa.name as sales_agent_name
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN booking_platform bp ON l.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON l.sales_agent_id = sa.id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    // Attach computed lease_status to each row
    for (const lease of leases) {
      lease.lease_status = computeLeaseStatus(lease);
    }

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

// GET /api/leasing/calendar - Get calendar data for all units with leases in date range
router.get('/calendar', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { startDate, endDate, propertyId, unitId, search } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ code: 400, message: 'startDate and endDate are required' });
    }

    const today = new Date().toISOString().slice(0, 10);

    // Get all active units with their property info + current tenant
    let unitWhere = 'u.active_status = 1 AND p.org_id = ? AND p.deleted_at IS NULL';
    const unitParams = [today, today, orgId];
    if (propertyId) {
      unitWhere += ' AND p.id = ?';
      unitParams.push(propertyId);
    }
    if (unitId) {
      unitWhere += ' AND u.id = ?';
      unitParams.push(unitId);
    }
    if (search) {
      unitWhere += ' AND (u.name LIKE ? OR p.display_name LIKE ? OR t_search.first_name LIKE ? OR t_search.last_name LIKE ? OR CONCAT(COALESCE(t_search.first_name,""), " ", COALESCE(t_search.last_name,"")) LIKE ?)';
      const s = `%${search}%`;
      unitParams.push(s, s, s, s, s);
    }

    // Get units with current active tenant via subquery
    const [units] = await req.pool.execute(
      `SELECT DISTINCT u.id AS unit_id, u.name AS unit_name, p.id AS property_id, p.display_name AS property_name,
              cur_l.id AS current_lease_id,
              cur_t.first_name AS current_tenant_first, cur_t.last_name AS current_tenant_last,
              cur_t.company_name AS current_tenant_company, cur_t.type AS current_tenant_type,
              cur_l.amount AS current_rent, cur_l.contract_type AS current_contract_type, cur_l.end_date AS current_end_date
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing cur_l ON cur_l.unit_id = u.id AND cur_l.deleted_at IS NULL
         AND cur_l.start_date <= ? AND (cur_l.end_date >= ? OR cur_l.end_date IS NULL)
       LEFT JOIN tenant cur_t ON cur_l.tenant_id = cur_t.id
       ${search ? `LEFT JOIN leasing t_search_l ON t_search_l.unit_id = u.id AND t_search_l.deleted_at IS NULL
       LEFT JOIN tenant t_search ON t_search_l.tenant_id = t_search.id` : ''}
       WHERE ${unitWhere}
       ORDER BY p.display_name, u.name`,
      unitParams
    );

    if (units.length === 0) {
      return res.json({ code: 200, data: { units: [], properties: [] } });
    }

    const unitIds = units.map(u => u.unit_id);

    // Get all leases that overlap with the date range for these units
    const placeholders = unitIds.map(() => '?').join(',');
    const [leases] = await req.pool.execute(
      `SELECT l.id, l.unit_id, l.tenant_id, l.start_date, l.end_date, l.status, l.type, l.amount, l.price, l.contract_type,
              t.first_name, t.last_name, t.company_name, t.type AS tenant_type, t.phone, t.email
       FROM leasing l
       JOIN tenant t ON l.tenant_id = t.id
       WHERE l.unit_id IN (${placeholders})
         AND l.deleted_at IS NULL
         AND l.start_date <= ?
         AND (l.end_date >= ? OR l.end_date IS NULL)
       ORDER BY l.start_date ASC`,
      [...unitIds, endDate, startDate]
    );

    // Group leases by unit_id
    const leasesByUnit = {};
    for (const lease of leases) {
      const uid = String(lease.unit_id);
      if (!leasesByUnit[uid]) leasesByUnit[uid] = [];
      leasesByUnit[uid].push({
        id: String(lease.id),
        tenant_id: String(lease.tenant_id),
        tenant_name: lease.tenant_type === 1
          ? (lease.company_name || 'Company')
          : [lease.first_name, lease.last_name].filter(Boolean).join(' '),
        phone: lease.phone || null,
        email: lease.email || null,
        start_date: lease.start_date,
        end_date: lease.end_date,
        status: lease.status,
        lease_status: computeLeaseStatus(lease),
        type: lease.type,
        amount: lease.amount || lease.price,
        contract_type: lease.contract_type ?? null,
      });
    }

    // Build result grouped by property
    const propertyMap = {};
    for (const u of units) {
      const pid = String(u.property_id);
      if (!propertyMap[pid]) {
        propertyMap[pid] = { id: pid, name: u.property_name, units: [] };
      }
      const currentTenantName = u.current_tenant_first
        ? (Number(u.current_tenant_type) === 1
          ? (u.current_tenant_company || 'Company')
          : [u.current_tenant_first, u.current_tenant_last].filter(Boolean).join(' '))
        : null;
      propertyMap[pid].units.push({
        id: String(u.unit_id),
        name: u.unit_name,
        current_tenant: currentTenantName,
        current_lease_id: u.current_lease_id ? String(u.current_lease_id) : null,
        current_contract_type: u.current_contract_type ?? null,
        current_end_date: u.current_end_date || null,
        current_rent: u.current_rent || null,
        leases: leasesByUnit[String(u.unit_id)] || [],
      });
    }

    res.json({ code: 200, data: { properties: Object.values(propertyMap) } });
  } catch (error) {
    console.error('Calendar data error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load calendar data' });
  }
});

// GET /api/leasing/:id - Get lease detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name as unit_name, p.display_name as property_name,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              t.email as tenant_email, t.phone as tenant_phone,
              bp.name as booking_platform_name, sa.name as sales_agent_name
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN booking_platform bp ON l.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON l.sales_agent_id = sa.id
       WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL`,
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
    lease.lease_status = computeLeaseStatus(lease);

    res.json({ code: 200, data: lease });
  } catch (error) {
    console.error('Get lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get lease' });
  }
});

// GET /api/leasing/:id/settlement - Get settlement summary for a lease
router.get('/:id/settlement', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // 1. Get lease with tenant, unit, property info
    const [leases] = await req.pool.execute(
      `SELECT l.id, l.lease_no, l.unit_id, l.tenant_id, l.start_date, l.end_date,
              l.amount, l.price, l.deposit, l.settlement_notes,
              l.check_in_meter, l.check_out_meter,
              u.name as unit_name, p.display_name as property_name, p.id as property_id,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL`,
      [id, orgId]
    );
    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }
    const lease = leases[0];
    const monthlyRent = Number(lease.amount || lease.price || 0);
    const startDate = lease.start_date;
    const endDate = lease.end_date;

    // 2. Rental days and estimated total rent
    let rentalDays = 0;
    let estimatedTotalRent = 0;
    if (startDate && endDate) {
      const msPerDay = 86400000;
      rentalDays = Math.round((new Date(endDate) - new Date(startDate)) / msPerDay);
      estimatedTotalRent = (rentalDays / 365) * monthlyRent * 12;
    }

    // 3. Average utility rate during stay
    let avgUnitRate = null;
    let totalUtilityUsage = null;
    const checkIn = lease.check_in_meter != null ? Number(lease.check_in_meter) : null;
    const checkOut = lease.check_out_meter != null ? Number(lease.check_out_meter) : null;
    if (checkIn != null && checkOut != null) {
      totalUtilityUsage = checkOut - checkIn;
    }

    // Get average rate from utility bills during the lease period
    if (startDate && endDate && lease.unit_id) {
      const [rates] = await req.pool.execute(
        `SELECT AVG(b.rate_per_kw) as avg_rate
         FROM utility_bill b
         JOIN utility_bill_line bl ON bl.bill_id = b.id
         WHERE bl.unit_id = ? AND b.org_id = ?
           AND b.period_end >= ? AND b.period_start <= ?
           AND b.status = 1`,
        [lease.unit_id, orgId, startDate, endDate]
      );
      if (rates[0]?.avg_rate != null) {
        avgUnitRate = Math.ceil(Number(rates[0].avg_rate) * 100) / 100;
      }
    }

    let totalUtilityCost = null;
    if (totalUtilityUsage != null && avgUnitRate != null) {
      totalUtilityCost = Math.ceil(totalUtilityUsage * avgUnitRate * 100) / 100;
    }

    // 4. Get all invoices for this lease (inflow only — what tenant owes)
    const [invoices] = await req.pool.execute(
      `SELECT i.id, i.invoice_code, i.due_on, i.amount, i.type, i.status, i.note,
              cs.name as category_name,
              COALESCE(paid.total_paid, 0) as amount_paid,
              CASE i.status
                WHEN 1 THEN 0
                ELSE IF(i.amount IS NULL, 0, i.amount - COALESCE(paid.total_paid, 0))
              END as outstanding
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN (
         SELECT al.invoice_code, a.org_id, SUM(al.amount) as total_paid
         FROM accounting_line al
         JOIN accounting a ON al.accounting_id = a.id
         WHERE a.deleted_at IS NULL AND al.deleted_at IS NULL
         GROUP BY al.invoice_code, a.org_id
       ) paid ON paid.invoice_code = i.invoice_code AND paid.org_id = i.org_id
       WHERE i.leasing_id = ? AND i.org_id = ? AND i.deleted_at IS NULL
       ORDER BY i.due_on ASC, i.invoice_code ASC`,
      [id, orgId]
    );

    // 5. Get payment details for each invoice (for the Inflow/Outflow + Payment Method columns)
    const invoiceWithPayments = [];
    for (const inv of invoices) {
      const [payments] = await req.pool.execute(
        `SELECT a.payment_date, al.amount, pms.payment_method as payment_method_name, a.note as payment_note
         FROM accounting_line al
         JOIN accounting a ON al.accounting_id = a.id
         LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
         WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL
         ORDER BY a.payment_date ASC`,
        [inv.invoice_code, orgId]
      );
      invoiceWithPayments.push({ ...inv, payments });
    }

    // 6. Compute summary values
    // Rent received = sum of paid amounts on inflow invoices with "Rental" category
    const rentReceived = invoices
      .filter(i => Number(i.type) === 0 && (i.category_name || '').toLowerCase().includes('rental'))
      .reduce((sum, i) => sum + Number(i.amount_paid), 0);

    const rentDifference = estimatedTotalRent - rentReceived;
    const rentDiffPercent = rentReceived > 0 ? (rentDifference / rentReceived) * 100 : 0;

    // Payments received = sum of all amount_paid on inflow invoices
    const paymentsReceived = invoices
      .filter(i => Number(i.type) === 0)
      .reduce((sum, i) => sum + Number(i.amount_paid), 0);

    // Outstanding payments = sum of outstanding on inflow invoices that are not fully paid
    const outstandingPayments = invoices
      .filter(i => Number(i.type) === 0 && Number(i.status) !== 1)
      .reduce((sum, i) => sum + Number(i.outstanding), 0);

    // Tenant Credits = sum of inflow/outflow payments on "Credits" category invoices
    const tenantCredits = invoices
      .filter(i => (i.category_name || '').toLowerCase() === 'credits')
      .reduce((sum, i) => {
        const paid = Number(i.amount_paid);
        return sum + (Number(i.type) === 1 ? -paid : paid);
      }, 0);

    // Security deposit = net of inflow and outflow deposit payments
    const depositInflow = invoices
      .filter(i => (i.category_name || '').toLowerCase().includes('deposit') && Number(i.type) === 0)
      .reduce((sum, i) => sum + Number(i.amount_paid), 0);
    const depositOutflow = invoices
      .filter(i => (i.category_name || '').toLowerCase().includes('deposit') && Number(i.type) === 1)
      .reduce((sum, i) => sum + Number(i.amount_paid), 0);
    const securityDeposit = depositInflow - depositOutflow;

    // Security deposit return = security deposit + tenant credits - outstanding payments
    const securityDepositReturn = securityDeposit + tenantCredits - outstandingPayments;

    res.json({
      code: 200,
      data: {
        tenant: [lease.tenant_first_name, lease.tenant_last_name].filter(Boolean).join(' '),
        property: lease.property_name,
        unit: lease.unit_name,
        monthly_rent: monthlyRent,
        start_date: startDate,
        end_date: endDate,
        rental_days: rentalDays,
        check_in_meter: checkIn,
        check_out_meter: checkOut,
        avg_unit_rate: avgUnitRate,
        total_utility_usage: totalUtilityUsage,
        total_utility_cost: totalUtilityCost,
        invoices: invoiceWithPayments,
        estimated_total_rent: Math.round(estimatedTotalRent * 100) / 100,
        rent_received: Math.round(rentReceived * 100) / 100,
        rent_difference: Math.round(rentDifference * 100) / 100,
        rent_diff_percent: Math.round(rentDiffPercent * 100) / 100,
        payments_received: Math.round(paymentsReceived * 100) / 100,
        outstanding_payments: Math.round(outstandingPayments * 100) / 100,
        tenant_credits: Math.round(tenantCredits * 100) / 100,
        security_deposit: securityDeposit,
        security_deposit_return: Math.round(securityDepositReturn * 100) / 100,
        settlement_notes: lease.settlement_notes || '',
      }
    });
  } catch (error) {
    console.error('Get settlement error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get settlement data' });
  }
});

// PUT /api/leasing/:id/settlement-notes - Save settlement notes
router.put('/:id/settlement-notes', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { notes } = req.body;

    // Verify lease exists and belongs to org
    const [leases] = await req.pool.execute(
      `SELECT l.id FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL`,
      [id, orgId]
    );
    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }

    await req.pool.execute(
      'UPDATE leasing SET settlement_notes = ? WHERE id = ?',
      [notes || null, id]
    );

    res.json({ code: 200, message: 'Settlement notes saved' });
  } catch (error) {
    console.error('Save settlement notes error:', error);
    res.status(500).json({ code: 500, message: 'Failed to save settlement notes' });
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
      WHERE l.unit_id = ? AND l.deleted_at IS NULL
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
      contract_type, unit_information, note, credits, utility_credit,
      check_in_meter, check_out_meter,
      contact_phone, lease_no,
      additionalTenantIds,
      // notification flags
      tenant_posted, landlord_posted, landlord_due, tenant_due,
      landlord_overdue, tenant_overdue, landlord_expired, landlord_expired_days,
      tenant_checkin, tenant_checkout, tenant_renewal, tenant_renewal_days,
      tenant_deposit_posted, payment_receipt,
      // email
      email_template_id, access_setting, share_lease, all_past,
      mark_past_paid,
      // booking & commission
      booking_platform_id, sales_agent_id
    } = req.body;
    const orgId = req.user.orgId;

    // Server-side overlap check — block creation if dates conflict with an existing active lease on the same unit
    if (unit_id && start_date) {
      const overlapEnd = end_date || '2099-12-31';
      const [conflicts] = await req.pool.execute(
        `SELECT l.id, l.lease_no, l.start_date, l.end_date, t.first_name, t.last_name
         FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
         WHERE l.unit_id = ? AND l.deleted_at IS NULL
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
        amount, due_date, deposit, currency_id, contract_type, unit_information, note, credits, utility_credit,
        check_in_meter, check_out_meter, check_in_meter_updated_at, check_out_meter_updated_at,
        contact_phone, lease_no, first_invoice_date,
        access_setting, share_lease, all_past,
        tenant_posted, landlord_posted, landlord_due, tenant_due,
        landlord_overdue, tenant_overdue, landlord_expired, landlord_expired_days,
        tenant_checkin, tenant_checkout, tenant_renewal, tenant_renewal_days,
        tenant_deposit_posted, payment_receipt, email_template_id, booking_platform_id, sales_agent_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        leaseId.toString(), unit_id, tenant_id, start_date, end_date || null,
        price || 0, type || 0, invoicing || null,
        amount || price || 0, due_date || null, deposit || 0, currencyId,
        contract_type || 0, unit_information || null, note || null, credits || null, utility_credit ?? null,
        check_in_meter ?? null, check_out_meter ?? null,
        check_in_meter != null ? new Date() : null, check_out_meter != null ? new Date() : null,
        contact_phone || null, leaseNo, first_invoice_date || null,
        access_setting || null, share_lease ? 1 : 0, all_past ? 1 : 0,
        tenant_posted ? 1 : 0, landlord_posted ? 1 : 0,
        landlord_due ? 1 : 0, tenant_due ? 1 : 0,
        landlord_overdue ? 1 : 0, tenant_overdue ? 1 : 0,
        landlord_expired ? 1 : 0, landlord_expired_days || 0,
        tenant_checkin ? 1 : 0, tenant_checkout ? 1 : 0,
        tenant_renewal ? 1 : 0, tenant_renewal_days || 0,
        tenant_deposit_posted ? 1 : 0, payment_receipt ? 1 : 0, email_template_id || null,
        booking_platform_id || null, sales_agent_id || null
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
      const createOneInvoice = async (dueDate, status, amount) => {
        const invoiceCode = await generateInvoiceCode(req.pool, orgId);
        const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
        await req.pool.execute(
          `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
            invoice_code, amount, due_on, status, category, currency_id, type,
            booking_platform_id, sales_agent_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
          [invoiceId, orgId, tenant_id, unit_id, leaseId.toString(), propertyId,
           invoiceCode, amount, dueDate, status, rentCategoryId, currencyId,
           booking_platform_id || null, sales_agent_id || null]
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

          // Compute this period's end (day before the next scheduled due date)
          const nextCursor = advanceInvoiceDate(cursor, invoicing, due_date);
          const periodEnd = new Date(nextCursor);
          periodEnd.setDate(periodEnd.getDate() - 1);

          // Prorate if lease ends inside this period; otherwise full amount
          const thisAmount = computeRentInvoiceAmount({
            rent: invoiceAmount,
            invoicing,
            periodStart: cursor,
            periodEnd,
            leaseEnd: end_date,
          });

          if (thisAmount === null) break; // lease already over before this period

          if (isPast) {
            createdInvoices.push(await createOneInvoice(dateStr, mark_past_paid ? 1 : 0, thisAmount));
          } else {
            createdInvoices.push(await createOneInvoice(dateStr, 0, thisAmount));
            break;
          }
          cursor = nextCursor;
          count++;
        }
      } else {
        // NON-RECURRING: Create just ONE invoice (full amount; no prior bill to prorate against)
        const invoiceDate = first_invoice_date || start_date || today;
        const isPast = new Date(invoiceDate).getTime() <= todayMs;
        const invoiceStatus = (isPast && mark_past_paid) ? 1 : 0;
        createdInvoices.push(await createOneInvoice(invoiceDate, invoiceStatus, invoiceAmount));
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
          invoice_code, amount, due_on, status, category, currency_id, type,
          booking_platform_id, sales_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, NOW())`,
        [depInvoiceId.toString(), orgId, tenant_id, unit_id, leaseId.toString(), depPropertyId,
         depInvoiceCode, deposit, today, depositCategoryId, currencyId,
         booking_platform_id || null, sales_agent_id || null]
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

    // Auto-create checkout_cleaning if lease has an end_date
    if (end_date) {
      try {
        const [[unitInfo]] = await req.pool.execute('SELECT property_id FROM unit WHERE id = ?', [unit_id]);
        const cleanPropId = unitInfo ? unitInfo.property_id : null;
        const cleanId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
        await req.pool.execute(
          `INSERT INTO checkout_cleaning (id, org_id, lease_id, tenant_id, property_id, unit_id, cleaning_date, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          [cleanId, orgId, leaseId.toString(), tenant_id, cleanPropId, unit_id, end_date]
        );
      } catch (cleanErr) {
        console.error('Auto-create checkout_cleaning error (non-fatal):', cleanErr);
      }
    }

    await logActivity(req, 'CREATE', 'lease', leaseId.toString(), 'Created lease ' + (leaseNo || leaseId.toString()));
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
      note, credits, utility_credit, check_in_meter, check_out_meter,
      contact_phone, first_invoice_date, status,
      additionalTenantIds,
      mark_past_paid,
      booking_platform_id, sales_agent_id,
      payment_receipt,
      // Email notifications + access/sharing — mirror the create-lease payload
      tenant_posted, landlord_posted,
      tenant_due, landlord_due,
      tenant_overdue, landlord_overdue,
      tenant_deposit_posted,
      tenant_checkin, tenant_checkout,
      landlord_expired, landlord_expired_days,
      tenant_renewal, tenant_renewal_days,
      access_setting, share_lease, all_past
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
           WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.id != ?
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
    if (utility_credit !== undefined) { fields.push('utility_credit = ?'); params.push(utility_credit ?? null); }
    if (check_in_meter !== undefined) { fields.push('check_in_meter = ?'); params.push(check_in_meter ?? null); fields.push('check_in_meter_updated_at = NOW()'); }
    if (check_out_meter !== undefined) { fields.push('check_out_meter = ?'); params.push(check_out_meter ?? null); fields.push('check_out_meter_updated_at = NOW()'); }
    if (contact_phone !== undefined) { fields.push('contact_phone = ?'); params.push(contact_phone || null); }
    if (first_invoice_date !== undefined) { fields.push('first_invoice_date = ?'); params.push(first_invoice_date || null); }
    if (status !== undefined) { fields.push('status = ?'); params.push(status); }
    if (booking_platform_id !== undefined) { fields.push('booking_platform_id = ?'); params.push(booking_platform_id || null); }
    if (sales_agent_id !== undefined) { fields.push('sales_agent_id = ?'); params.push(sales_agent_id || null); }
    if (payment_receipt !== undefined) { fields.push('payment_receipt = ?'); params.push(payment_receipt ? 1 : 0); }
    // Email notifications
    if (tenant_posted !== undefined) { fields.push('tenant_posted = ?'); params.push(tenant_posted ? 1 : 0); }
    if (landlord_posted !== undefined) { fields.push('landlord_posted = ?'); params.push(landlord_posted ? 1 : 0); }
    if (tenant_due !== undefined) { fields.push('tenant_due = ?'); params.push(tenant_due ? 1 : 0); }
    if (landlord_due !== undefined) { fields.push('landlord_due = ?'); params.push(landlord_due ? 1 : 0); }
    if (tenant_overdue !== undefined) { fields.push('tenant_overdue = ?'); params.push(tenant_overdue ? 1 : 0); }
    if (landlord_overdue !== undefined) { fields.push('landlord_overdue = ?'); params.push(landlord_overdue ? 1 : 0); }
    if (tenant_deposit_posted !== undefined) { fields.push('tenant_deposit_posted = ?'); params.push(tenant_deposit_posted ? 1 : 0); }
    if (tenant_checkin !== undefined) { fields.push('tenant_checkin = ?'); params.push(tenant_checkin ? 1 : 0); }
    if (tenant_checkout !== undefined) { fields.push('tenant_checkout = ?'); params.push(tenant_checkout ? 1 : 0); }
    if (landlord_expired !== undefined) { fields.push('landlord_expired = ?'); params.push(landlord_expired ? 1 : 0); }
    if (landlord_expired_days !== undefined) { fields.push('landlord_expired_days = ?'); params.push(landlord_expired_days || 0); }
    if (tenant_renewal !== undefined) { fields.push('tenant_renewal = ?'); params.push(tenant_renewal ? 1 : 0); }
    if (tenant_renewal_days !== undefined) { fields.push('tenant_renewal_days = ?'); params.push(tenant_renewal_days || 0); }
    // Access & sharing
    if (access_setting !== undefined) { fields.push('access_setting = ?'); params.push(access_setting || null); }
    if (share_lease !== undefined) { fields.push('share_lease = ?'); params.push(share_lease ? 1 : 0); }
    if (all_past !== undefined) { fields.push('all_past = ?'); params.push(all_past ? 1 : 0); }
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

    await logActivity(req, 'UPDATE', 'lease', id, 'Updated lease ' + id);
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
    await logActivity(req, 'DELETE', 'lease', id, 'Deleted lease ' + id);
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
      'SELECT l.*, t.first_name, t.last_name, t.email, t.phone FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id WHERE l.unit_id = ? AND l.deleted_at IS NULL',
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
       WHERE p.org_id = ? AND l.deleted_at IS NULL
         AND DATEDIFF(l.end_date, NOW()) BETWEEN 0 AND 30
       ORDER BY l.end_date ASC LIMIT ${limit} OFFSET ${offset}`,
      [orgId]
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
       WHERE p.org_id = ? AND u.active_status = 1 AND NOT EXISTS (
         SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
           AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       )
       ORDER BY p.display_name, u.name`,
      [orgId]
    );

    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get available units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get available units' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// LEASE REVISIONS — scheduled mid-lease changes for rent / credits / etc.
// Each row in `lease_revision` takes effect on its `effective_from` date.
// The invoice scheduler picks the latest revision whose effective_from <= due_on.
// ───────────────────────────────────────────────────────────────────────────

// Helper: confirm lease exists & belongs to this org
async function verifyLeaseOwnership(pool, leaseId, orgId) {
  const [[row]] = await pool.execute(
    `SELECT l.id FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL`,
    [leaseId, orgId]
  );
  return !!row;
}

// GET /api/leasing/:id/revisions — all non-deleted revisions for a lease
router.get('/:id/revisions', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    if (!(await verifyLeaseOwnership(req.pool, id, orgId))) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }
    const [revs] = await req.pool.execute(
      `SELECT id, lease_id, effective_from, price, credits, utility_credit, deposit,
              note, created_by, created_at, updated_at
       FROM lease_revision
       WHERE lease_id = ? AND deleted_at IS NULL
       ORDER BY effective_from ASC, id ASC`,
      [id]
    );
    res.json({ code: 200, data: revs });
  } catch (error) {
    console.error('List lease revisions error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list revisions' });
  }
});

// POST /api/leasing/:id/revisions — schedule a new revision
// Body: { effective_from, price?, credits?, utility_credit?, deposit?, note? }
router.post('/:id/revisions', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const { effective_from, price, credits, utility_credit, deposit, note } = req.body || {};

    if (!effective_from || !/^\d{4}-\d{2}-\d{2}$/.test(effective_from)) {
      return res.status(400).json({ code: 400, message: 'effective_from is required (YYYY-MM-DD)' });
    }
    // At least one field must change
    if (price == null && credits == null && utility_credit == null && deposit == null) {
      return res.status(400).json({ code: 400, message: 'Provide at least one of: price, credits, utility_credit, deposit' });
    }
    if (!(await verifyLeaseOwnership(req.pool, id, orgId))) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }

    const revId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    await req.pool.execute(
      `INSERT INTO lease_revision (id, lease_id, effective_from, price, credits, utility_credit, deposit, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        revId, id, effective_from,
        price != null && price !== '' ? Number(price) : null,
        credits != null && credits !== '' ? String(credits) : null,
        utility_credit != null && utility_credit !== '' ? Number(utility_credit) : null,
        deposit != null && deposit !== '' ? Number(deposit) : null,
        note || null,
        userId || null,
      ]
    );
    await logActivity(req, 'CREATE', 'lease_revision', revId,
      `Scheduled rate change on lease ${id} effective ${effective_from}`,
      { lease_id: id, effective_from, price, credits, utility_credit, deposit });

    res.json({ code: 200, message: 'Revision scheduled', data: { id: revId } });
  } catch (error) {
    console.error('Create lease revision error:', error);
    res.status(500).json({ code: 500, message: 'Failed to schedule revision' });
  }
});

// PUT /api/leasing/:id/revisions/:rid — edit a not-yet-effective revision
router.put('/:id/revisions/:rid', authenticate, async (req, res) => {
  try {
    const { id, rid } = req.params;
    const orgId = req.user.orgId;
    const { effective_from, price, credits, utility_credit, deposit, note } = req.body || {};

    if (!(await verifyLeaseOwnership(req.pool, id, orgId))) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }

    // Reject edits to revisions that have already taken effect (they're
    // already reflected in past invoices; changing them would create drift).
    const [[existing]] = await req.pool.execute(
      `SELECT effective_from FROM lease_revision
       WHERE id = ? AND lease_id = ? AND deleted_at IS NULL`,
      [rid, id]
    );
    if (!existing) return res.status(404).json({ code: 404, message: 'Revision not found' });
    const today = new Date().toISOString().split('T')[0];
    const existingDateStr = existing.effective_from instanceof Date
      ? existing.effective_from.toISOString().split('T')[0]
      : String(existing.effective_from).split('T')[0];
    if (existingDateStr <= today) {
      return res.status(400).json({ code: 400, message: 'Cannot edit a revision that has already taken effect' });
    }

    if (effective_from && !/^\d{4}-\d{2}-\d{2}$/.test(effective_from)) {
      return res.status(400).json({ code: 400, message: 'effective_from must be YYYY-MM-DD' });
    }

    await req.pool.execute(
      `UPDATE lease_revision
       SET effective_from = COALESCE(?, effective_from),
           price          = ?,
           credits        = ?,
           utility_credit = ?,
           deposit        = ?,
           note           = ?
       WHERE id = ? AND lease_id = ? AND deleted_at IS NULL`,
      [
        effective_from || null,
        price != null && price !== '' ? Number(price) : null,
        credits != null && credits !== '' ? String(credits) : null,
        utility_credit != null && utility_credit !== '' ? Number(utility_credit) : null,
        deposit != null && deposit !== '' ? Number(deposit) : null,
        note || null,
        rid, id,
      ]
    );
    await logActivity(req, 'UPDATE', 'lease_revision', rid,
      `Edited scheduled rate change on lease ${id}`,
      { lease_id: id, effective_from, price, credits, utility_credit, deposit });

    res.json({ code: 200, message: 'Revision updated' });
  } catch (error) {
    console.error('Update lease revision error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update revision' });
  }
});

// DELETE /api/leasing/:id/revisions/:rid — cancel a not-yet-effective revision
router.delete('/:id/revisions/:rid', authenticate, async (req, res) => {
  try {
    const { id, rid } = req.params;
    const orgId = req.user.orgId;
    if (!(await verifyLeaseOwnership(req.pool, id, orgId))) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }
    const [[existing]] = await req.pool.execute(
      `SELECT effective_from FROM lease_revision
       WHERE id = ? AND lease_id = ? AND deleted_at IS NULL`,
      [rid, id]
    );
    if (!existing) return res.status(404).json({ code: 404, message: 'Revision not found' });
    const today = new Date().toISOString().split('T')[0];
    const existingDateStr = existing.effective_from instanceof Date
      ? existing.effective_from.toISOString().split('T')[0]
      : String(existing.effective_from).split('T')[0];
    if (existingDateStr <= today) {
      return res.status(400).json({ code: 400, message: 'Cannot cancel a revision that has already taken effect' });
    }

    await req.pool.execute(
      `UPDATE lease_revision SET deleted_at = NOW() WHERE id = ? AND lease_id = ?`,
      [rid, id]
    );
    await logActivity(req, 'DELETE', 'lease_revision', rid,
      `Cancelled scheduled rate change on lease ${id}`);

    res.json({ code: 200, message: 'Revision cancelled' });
  } catch (error) {
    console.error('Delete lease revision error:', error);
    res.status(500).json({ code: 500, message: 'Failed to cancel revision' });
  }
});

module.exports = router;
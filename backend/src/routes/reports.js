const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const { periodsPerYear } = require('../utils/rentProrata');

// GET /api/reports/vacancy-cost
// Query params: startDate, endDate, propertyIds (comma-separated)
router.get('/vacancy-cost', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { startDate, endDate, propertyIds } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ code: 400, message: 'startDate and endDate are required' });
    }

    const rangeStart = new Date(startDate + 'T00:00:00Z');
    const rangeEnd = new Date(endDate + 'T00:00:00Z');

    if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime()) || rangeEnd < rangeStart) {
      return res.status(400).json({ code: 400, message: 'Invalid date range' });
    }

    const totalDaysInRange = Math.round((rangeEnd - rangeStart) / 86400000) + 1;

    // Build property filter
    let propertyFilter = 'p.org_id = ? AND p.deleted_at IS NULL AND p.status = 1';
    const propertyParams = [orgId];

    if (propertyIds) {
      const ids = propertyIds.split(',').map(id => id.trim()).filter(Boolean);
      if (ids.length > 0) {
        propertyFilter += ` AND p.id IN (${ids.map(() => '?').join(',')})`;
        propertyParams.push(...ids);
      }
    }

    // Fetch properties with leasing_cost and active unit counts
    const [properties] = await req.pool.execute(
      `SELECT p.id, p.display_name, COALESCE(p.leasing_cost, 0) AS leasing_cost
       FROM property p
       WHERE ${propertyFilter}
       ORDER BY p.display_name`,
      propertyParams
    );

    if (properties.length === 0) {
      return res.json({ code: 200, data: { rows: [] } });
    }

    const propIds = properties.map(p => p.id);
    const placeholders = propIds.map(() => '?').join(',');

    // Fetch active units per property
    const [units] = await req.pool.execute(
      `SELECT id, property_id, rent_price_min
       FROM unit
       WHERE property_id IN (${placeholders}) AND active_status = 1`,
      propIds
    );

    // Fetch leases overlapping the date range for properties in scope
    // A lease overlaps [rangeStart, rangeEnd] if:
    //   lease.start_date <= rangeEnd AND (lease.end_date >= rangeStart OR lease.end_date IS NULL)
    const [leases] = await req.pool.execute(
      `SELECT l.id, l.unit_id, l.start_date, l.end_date, l.amount, l.invoicing,
              u.property_id
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       WHERE u.property_id IN (${placeholders})
         AND l.deleted_at IS NULL
         AND l.start_date <= ?
         AND (l.end_date >= ? OR l.end_date IS NULL)`,
      [...propIds, endDate, startDate]
    );

    // Fetch rental invoices in bulk for all leases in scope
    const allLeaseIds = leases.map(l => l.id);
    let invoicesByLease = {};
    if (allLeaseIds.length > 0) {
      const leasePlaceholders = allLeaseIds.map(() => '?').join(',');
      const [invoiceRows] = await req.pool.execute(
        `SELECT i.id, i.leasing_id, i.due_on, i.amount
         FROM invoice i
         JOIN category_setting c ON c.id = i.category
         WHERE i.leasing_id IN (${leasePlaceholders})
           AND i.deleted_at IS NULL
           AND i.type = 0
           AND LOWER(c.name) LIKE '%rental%'
         ORDER BY i.due_on ASC`,
        allLeaseIds
      );
      for (const row of invoiceRows) {
        const key = row.leasing_id.toString();
        if (!invoicesByLease[key]) invoicesByLease[key] = [];
        invoicesByLease[key].push(row);
      }
    }

    // Helper: clamp date to rangeStart/rangeEnd (JS Date objects, UTC midnight)
    const clamp = (d, lo, hi) => d < lo ? lo : d > hi ? hi : d;
    const toUTC = (val) => {
      if (!val) return null;
      const s = typeof val === 'string' ? val : val.toISOString().slice(0, 10);
      const [y, m, d] = s.slice(0, 10).split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    };

    // Group units and leases by property
    const unitsByProp = {};
    for (const u of units) {
      const pid = u.property_id.toString();
      if (!unitsByProp[pid]) unitsByProp[pid] = [];
      unitsByProp[pid].push(u);
    }

    const leasesByUnit = {};
    for (const l of leases) {
      const uid = l.unit_id.toString();
      if (!leasesByUnit[uid]) leasesByUnit[uid] = [];
      leasesByUnit[uid].push(l);
    }

    const rows = [];

    for (const prop of properties) {
      const pid = prop.id.toString();
      const propUnits = unitsByProp[pid] || [];
      const activeUnits = propUnits.length;
      const days = activeUnits * totalDaysInRange;
      const leasingCost = Number(prop.leasing_cost) || 0;

      // EL = sum of rent_price_min across active units
      const el = propUnits.reduce((sum, u) => sum + (Number(u.rent_price_min) || 0), 0);

      // Rental income + vacant days
      let rentalIncome = 0;
      let vacantDays = 0;

      for (const unit of propUnits) {
        const uid = unit.id.toString();
        const unitLeases = leasesByUnit[uid] || [];

        let unitCoveredDays = 0;

        for (const lease of unitLeases) {
          const leaseStart = toUTC(lease.start_date);
          const leaseEnd = lease.end_date ? toUTC(lease.end_date) : null;

          // Overlap with range
          const overlapStart = clamp(leaseStart, rangeStart, rangeEnd);
          const overlapEnd = leaseEnd
            ? clamp(leaseEnd, rangeStart, rangeEnd)
            : rangeEnd;
          const overlapDays = Math.round((overlapEnd - overlapStart) / 86400000) + 1;

          if (overlapDays <= 0) continue;

          // Covered days for vacant calculation
          unitCoveredDays += overlapDays;

          // Per-invoice proration
          const leaseId = lease.id.toString();
          const invoices = invoicesByLease[leaseId] || [];

          if (invoices.length === 0) {
            // Fallback: no invoices yet — use amount-based daily rate
            const ppy = periodsPerYear(lease.invoicing);
            const dailyRate = (Number(lease.amount) * ppy) / 365;
            rentalIncome += dailyRate * overlapDays;
          } else {
            for (let i = 0; i < invoices.length; i++) {
              const inv = invoices[i];
              const coverageStart = toUTC(inv.due_on);
              let coverageEnd;
              if (i + 1 < invoices.length) {
                coverageEnd = new Date(toUTC(invoices[i + 1].due_on).getTime() - 86400000);
              } else if (leaseEnd !== null) {
                coverageEnd = leaseEnd;
              } else {
                const ppy = periodsPerYear(lease.invoicing);
                const periodLength = Math.round(365 / ppy);
                coverageEnd = new Date(coverageStart.getTime() + (periodLength - 1) * 86400000);
              }
              const coverageDays = Math.max(1, Math.round((coverageEnd - coverageStart) / 86400000) + 1);
              const invoiceDailyRate = Number(inv.amount) / coverageDays;
              const invOverlapStart = coverageStart > rangeStart ? coverageStart : rangeStart;
              const invOverlapEnd = coverageEnd < rangeEnd ? coverageEnd : rangeEnd;
              const invOverlapDays = Math.max(0, Math.round((invOverlapEnd - invOverlapStart) / 86400000) + 1);
              rentalIncome += invoiceDailyRate * invOverlapDays;
            }
          }
        }

        // Clamp covered days to totalDaysInRange (defend against overlapping leases)
        unitCoveredDays = Math.min(unitCoveredDays, totalDaysInRange);
        vacantDays += totalDaysInRange - unitCoveredDays;
      }

      const rentPerUnit = days > 0 ? rentalIncome / days : 0;
      const vacantCost = days > 0 ? (leasingCost / days) * vacantDays : 0;
      const variance = rentalIncome - el;

      rows.push({
        property_id: pid,
        property_name: prop.display_name,
        active_units: activeUnits,
        days,
        rental_income: Math.round(rentalIncome * 100) / 100,
        rent_per_unit: Math.round(rentPerUnit * 100) / 100,
        leasing_cost: Math.round(leasingCost * 100) / 100,
        vacant_days: vacantDays,
        vacant_cost: Math.round(vacantCost * 100) / 100,
        el: Math.round(el * 100) / 100,
        variance: Math.round(variance * 100) / 100,
      });
    }

    res.json({ code: 200, data: { rows } });
  } catch (error) {
    console.error('Vacancy cost report error:', error);
    res.status(500).json({ code: 500, message: 'Failed to generate vacancy cost report' });
  }
});

// GET /api/reports/vacancy-cost/units
// Query params: startDate, endDate, propertyIds (comma-separated), unitIds (comma-separated)
router.get('/vacancy-cost/units', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { startDate, endDate, propertyIds, unitIds } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ code: 400, message: 'startDate and endDate are required' });
    }

    const rangeStart = new Date(startDate + 'T00:00:00Z');
    const rangeEnd = new Date(endDate + 'T00:00:00Z');

    if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime()) || rangeEnd < rangeStart) {
      return res.status(400).json({ code: 400, message: 'Invalid date range' });
    }

    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

    // Resolve properties in scope
    let propertyFilter = 'p.org_id = ? AND p.deleted_at IS NULL AND p.status = 1';
    const propertyParams = [orgId];
    if (propertyIds) {
      const ids = propertyIds.split(',').map(id => id.trim()).filter(Boolean);
      if (ids.length > 0) {
        propertyFilter += ` AND p.id IN (${ids.map(() => '?').join(',')})`;
        propertyParams.push(...ids);
      }
    }

    const [properties] = await req.pool.execute(
      `SELECT p.id, p.display_name FROM property p WHERE ${propertyFilter} ORDER BY p.display_name`,
      propertyParams
    );

    if (properties.length === 0) {
      return res.json({ code: 200, data: { rows: [] } });
    }

    const propIds = properties.map(p => p.id);
    const propPlaceholders = propIds.map(() => '?').join(',');

    // Resolve units in scope
    let unitFilter = `u.property_id IN (${propPlaceholders}) AND u.active_status = 1`;
    const unitParams = [...propIds];
    if (unitIds) {
      const ids = unitIds.split(',').map(id => id.trim()).filter(Boolean);
      if (ids.length > 0) {
        unitFilter += ` AND u.id IN (${ids.map(() => '?').join(',')})`;
        unitParams.push(...ids);
      }
    }

    const [units] = await req.pool.execute(
      `SELECT u.id, u.name, u.property_id FROM unit u WHERE ${unitFilter} ORDER BY u.name`,
      unitParams
    );

    if (units.length === 0) {
      return res.json({ code: 200, data: { rows: [] } });
    }

    // Build property lookup
    const propById = {};
    for (const p of properties) {
      propById[p.id.toString()] = p;
    }

    const unitIds2 = units.map(u => u.id);
    const unitPlaceholders = unitIds2.map(() => '?').join(',');

    // Fetch all leases for in-scope units, ordered by start_date ASC
    const [leases] = await req.pool.execute(
      `SELECT l.id, l.unit_id, l.start_date, l.end_date
       FROM leasing l
       WHERE l.unit_id IN (${unitPlaceholders})
         AND l.deleted_at IS NULL
       ORDER BY l.unit_id, l.start_date ASC`,
      unitIds2
    );

    // Group leases by unit_id
    const leasesByUnit = {};
    for (const l of leases) {
      const uid = l.unit_id.toString();
      if (!leasesByUnit[uid]) leasesByUnit[uid] = [];
      leasesByUnit[uid].push(l);
    }

    const toUTC = (val) => {
      if (!val) return null;
      const s = typeof val === 'string' ? val : val.toISOString().slice(0, 10);
      return new Date(s.slice(0, 10) + 'T00:00:00Z');
    };

    const daysBetween = (a, b) => {
      if (!a || !b) return 0;
      return Math.floor((a.getTime() - b.getTime()) / 86400000);
    };

    const fmtDate = (d) => {
      if (!d) return null;
      const iso = d instanceof Date ? d.toISOString() : new Date(d).toISOString();
      return iso.slice(0, 10);
    };

    const rows = [];

    for (const unit of units) {
      const uid = unit.id.toString();
      const prop = propById[unit.property_id.toString()];
      const unitLeases = leasesByUnit[uid] || [];

      if (unitLeases.length === 0) continue;

      // Sort by start_date ascending (already sorted from DB, but ensure)
      unitLeases.sort((a, b) => {
        const da = toUTC(a.start_date);
        const db = toUTC(b.start_date);
        return da - db;
      });

      const emitRow = (spellStart, spellEnd, nextLease) => {
        if (!spellStart || !spellEnd) return;
        if (spellEnd <= spellStart) return;

        const daysVacant = Math.max(0, daysBetween(spellEnd, spellStart));

        // Period vacancy: overlap of [spellStart, spellEnd) with [rangeStart, rangeEnd]
        const overlapStart = spellStart > rangeStart ? spellStart : rangeStart;
        const overlapEnd = spellEnd < rangeEnd ? spellEnd : rangeEnd;
        // overlapEnd is exclusive (spellEnd is the start of next lease, not an occupied day)
        // Use raw diff: days between overlapEnd and overlapStart
        const periodVacancy = Math.max(0, daysBetween(overlapEnd, overlapStart));

        if (daysVacant <= 0) return;

        rows.push({
          property_id: prop.id.toString(),
          property_name: prop.display_name,
          unit_id: uid,
          unit_name: unit.name,
          lease_end: fmtDate(spellStart),
          status: nextLease ? 'Booked' : 'Vacant',
          booked_on: nextLease ? fmtDate(toUTC(nextLease.start_date)) : null,
          period_vacancy: periodVacancy,
          days_vacant: daysVacant,
        });
      };

      // Iterate consecutive lease pairs for inter-lease vacancy spells
      for (let i = 0; i < unitLeases.length - 1; i++) {
        const prev = unitLeases[i];
        const next = unitLeases[i + 1];

        if (!prev.end_date) continue; // open-ended lease, no gap after it yet

        const spellStart = toUTC(prev.end_date);
        const spellEnd = toUTC(next.start_date);

        // Only emit if spell overlaps the query range
        if (spellStart >= rangeEnd) continue;
        if (spellEnd <= rangeStart) continue;

        emitRow(spellStart, spellEnd, next);
      }

      // Trailing vacancy: after the last lease
      const last = unitLeases[unitLeases.length - 1];
      if (last.end_date) {
        const spellStart = toUTC(last.end_date);
        // Cap spellEnd at min(rangeEnd, today) — no next lease
        const cap = today < rangeEnd ? today : rangeEnd;
        const spellEnd = cap;

        if (spellStart < rangeEnd && spellEnd > rangeStart && spellEnd > spellStart) {
          emitRow(spellStart, spellEnd, null);
        }
      }
    }

    // Sort: property_name ASC, unit_name ASC, lease_end ASC
    rows.sort((a, b) => {
      if (a.property_name < b.property_name) return -1;
      if (a.property_name > b.property_name) return 1;
      if (a.unit_name < b.unit_name) return -1;
      if (a.unit_name > b.unit_name) return 1;
      if (a.lease_end < b.lease_end) return -1;
      if (a.lease_end > b.lease_end) return 1;
      return 0;
    });

    res.json({ code: 200, data: { rows } });
  } catch (error) {
    console.error('Vacancy cost units report error:', error);
    res.status(500).json({ code: 500, message: 'Failed to generate unit breakdown report' });
  }
});

// ---------------------------------------------------------------------------
// COMMISSION TRACKER
// ---------------------------------------------------------------------------
// Aggregates Sales Agent and Booking Platform performance over a date range:
//   • New Leases     — count of leases whose start_date falls inside [from, to]
//   • Active Leases  — count of leases whose tenancy overlaps [from, to]
//   • Revenue        — gross rental-income invoiced, prorated for invoices that
//                      cover a multi-month period (e.g. Airbnb bulk payments)
//
// Revenue rules:
//   - Only Inflow (type=0) invoices.
//   - Only category named "Rental Income" (case-insensitive contains "rental").
//   - For an invoice's covered window we derive `[due_on, due_on + interval)`
//     where `interval` comes from leasing.invoicing. If invoicing is null/empty
//     (bulk Airbnb-style), we treat the covered window as the full lease span
//     [lease.start_date, lease.end_date]. The invoice's contribution is then
//     `amount * (overlap_days / covered_days)`.
//
// Two queries return:
//   { by_agent: [...], by_platform: [...] }
// Each row also exposes the contributing leases (drill-down on the frontend).
// ---------------------------------------------------------------------------

const INVOICING_DAYS = {
  weekly: 7,
  'bi-weekly': 14,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  'bi-annually': 182,
  biannually: 182,
  annually: 365,
  yearly: 365,
};

function intervalDays(invoicing) {
  if (invoicing == null) return null;
  const s = String(invoicing).trim().toLowerCase();
  if (!s) return null;
  if (INVOICING_DAYS[s] != null) return INVOICING_DAYS[s];
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toUtcDate(d) {
  if (!d) return null;
  if (d instanceof Date) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const s = typeof d === 'string' ? d.slice(0, 10) : String(d);
  const dt = new Date(s + 'T00:00:00Z');
  return isNaN(dt.getTime()) ? null : dt;
}

function dayDiff(a, b) {
  // Inclusive day count between two UTC dates.
  return Math.round((b - a) / 86400000) + 1;
}

function overlapDays(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (end < start) return 0;
  return dayDiff(start, end);
}

router.get('/commission', authenticate, requirePermission('LANDLORD/REPORT/COMMISSION_VIEW'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ code: 400, message: 'from and to are required (YYYY-MM-DD)' });
    }
    const rangeStart = toUtcDate(from);
    const rangeEnd = toUtcDate(to);
    if (!rangeStart || !rangeEnd || rangeEnd < rangeStart) {
      return res.status(400).json({ code: 400, message: 'Invalid date range' });
    }

    // ---- 1. Find the Rental Income category id(s) for this org ----
    const [catRows] = await req.pool.execute(
      `SELECT id FROM category_setting
       WHERE org_id = ? AND LOWER(name) LIKE '%rental%' AND enabled = 1`,
      [orgId]
    );
    const rentalCatIds = catRows.map(r => r.id.toString());
    if (rentalCatIds.length === 0) {
      // No rental income category exists — return empty totals.
      return res.json({ code: 200, data: { by_agent: [], by_platform: [], totals: { new_leases: 0, active_leases: 0, revenue: 0 } } });
    }

    // ---- 2. Pull every lease that could possibly contribute ----
    // A lease contributes if EITHER its start_date falls in [from, to] (new lease)
    // OR its tenancy overlaps [from, to] (active lease that may have invoices in range).
    const [leases] = await req.pool.execute(
      `SELECT l.id, l.lease_no, l.start_date, l.end_date, l.invoicing,
              l.sales_agent_id, l.booking_platform_id,
              sa.name AS sales_agent_name,
              bp.name AS booking_platform_name,
              u.name AS unit_name, p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.type AS tenant_type
         FROM leasing l
         LEFT JOIN sales_agent sa ON l.sales_agent_id = sa.id
         LEFT JOIN booking_platform bp ON l.booking_platform_id = bp.id
         LEFT JOIN unit u ON l.unit_id = u.id
         LEFT JOIN property p ON u.property_id = p.id
         LEFT JOIN tenant t ON l.tenant_id = t.id
         WHERE p.org_id = ? AND l.deleted_at IS NULL
           AND (
             (l.start_date BETWEEN ? AND ?)
             OR (l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL))
           )`,
      [orgId, from, to, to, from]
    );

    if (leases.length === 0) {
      return res.json({ code: 200, data: { by_agent: [], by_platform: [], totals: { new_leases: 0, active_leases: 0, revenue: 0 } } });
    }

    const leaseById = new Map();
    leases.forEach(l => leaseById.set(l.id.toString(), l));

    // ---- 3. Pull all rental-income invoices for those leases ----
    const leaseIds = leases.map(l => l.id.toString());
    const placeholders = leaseIds.map(() => '?').join(',');
    const catPlaceholders = rentalCatIds.map(() => '?').join(',');
    const [invoices] = await req.pool.execute(
      `SELECT i.id, i.leasing_id, i.amount, i.due_on, i.type, i.category
         FROM invoice i
         WHERE i.org_id = ?
           AND i.leasing_id IN (${placeholders})
           AND i.category IN (${catPlaceholders})
           AND i.type = 0
           AND i.deleted_at IS NULL`,
      [orgId, ...leaseIds, ...rentalCatIds]
    );

    // ---- 4. Prorate each invoice by its covered window ∩ [rangeStart, rangeEnd] ----
    const leaseProratedRevenue = new Map(); // leaseId -> revenue in range
    leases.forEach(l => leaseProratedRevenue.set(l.id.toString(), 0));

    for (const inv of invoices) {
      const lease = leaseById.get(inv.leasing_id.toString());
      if (!lease) continue;

      const dueOn = toUtcDate(inv.due_on);
      if (!dueOn) continue;

      const interval = intervalDays(lease.invoicing);
      let coveredStart, coveredEnd;
      if (interval != null) {
        // Recurring invoice: window is [due_on, due_on + interval - 1].
        coveredStart = dueOn;
        coveredEnd = new Date(dueOn.getTime() + (interval - 1) * 86400000);
      } else {
        // Bulk/Airbnb invoice: window is the entire lease span.
        coveredStart = toUtcDate(lease.start_date) || dueOn;
        coveredEnd = toUtcDate(lease.end_date) || dueOn;
        if (coveredEnd < coveredStart) coveredEnd = coveredStart;
      }

      const coveredDays = dayDiff(coveredStart, coveredEnd);
      const overlap = overlapDays(coveredStart, coveredEnd, rangeStart, rangeEnd);
      if (overlap <= 0 || coveredDays <= 0) continue;

      const contribution = (Number(inv.amount) || 0) * (overlap / coveredDays);
      leaseProratedRevenue.set(
        lease.id.toString(),
        (leaseProratedRevenue.get(lease.id.toString()) || 0) + contribution
      );
    }

    // ---- 5. Bucket leases into "new" vs "active" + accumulate by agent / platform ----
    const buckets = {
      by_agent: new Map(),    // key = agent_id (or '__none__')
      by_platform: new Map(), // key = platform_id (or '__none__')
    };

    const ensureBucket = (map, key, name) => {
      if (!map.has(key)) {
        map.set(key, {
          key, name,
          new_leases: 0,
          active_leases: 0,
          revenue: 0,
          leases: [],
        });
      }
      return map.get(key);
    };

    let totalsNew = 0, totalsActive = 0, totalsRevenue = 0;

    for (const l of leases) {
      const startDate = toUtcDate(l.start_date);
      const endDate = toUtcDate(l.end_date) || rangeEnd; // open-ended lease
      const isNew = startDate && startDate >= rangeStart && startDate <= rangeEnd;
      const isActive = startDate && startDate <= rangeEnd && endDate >= rangeStart;
      const revenue = leaseProratedRevenue.get(l.id.toString()) || 0;

      const tenantName =
        Number(l.tenant_type) === 1 && l.tenant_company_name
          ? l.tenant_company_name
          : [l.tenant_first_name, l.tenant_last_name].filter(Boolean).join(' ');

      const leaseEntry = {
        id: l.id.toString(),
        lease_no: l.lease_no,
        tenant_name: tenantName,
        unit_name: l.unit_name,
        property_name: l.property_name,
        start_date: l.start_date,
        end_date: l.end_date,
        invoicing: l.invoicing,
        is_new: !!isNew,
        is_active: !!isActive,
        revenue: Math.round(revenue * 100) / 100,
      };

      const agentKey = l.sales_agent_id ? l.sales_agent_id.toString() : '__none__';
      const agentName = l.sales_agent_name || '(Unassigned)';
      const agentRow = ensureBucket(buckets.by_agent, agentKey, agentName);
      if (isNew) agentRow.new_leases++;
      if (isActive) agentRow.active_leases++;
      agentRow.revenue += revenue;
      agentRow.leases.push(leaseEntry);

      const platformKey = l.booking_platform_id ? l.booking_platform_id.toString() : '__none__';
      const platformName = l.booking_platform_name || '(Unassigned)';
      const platformRow = ensureBucket(buckets.by_platform, platformKey, platformName);
      if (isNew) platformRow.new_leases++;
      if (isActive) platformRow.active_leases++;
      platformRow.revenue += revenue;
      platformRow.leases.push(leaseEntry);

      if (isNew) totalsNew++;
      if (isActive) totalsActive++;
      totalsRevenue += revenue;
    }

    const finalise = (map) => Array.from(map.values())
      .map(r => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      code: 200,
      data: {
        by_agent: finalise(buckets.by_agent),
        by_platform: finalise(buckets.by_platform),
        totals: {
          new_leases: totalsNew,
          active_leases: totalsActive,
          revenue: Math.round(totalsRevenue * 100) / 100,
        },
      },
    });
  } catch (error) {
    console.error('Commission report error:', error);
    res.status(500).json({ code: 500, message: 'Failed to generate commission report' });
  }
});

module.exports = router;

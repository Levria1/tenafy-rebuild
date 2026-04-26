const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
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

module.exports = router;

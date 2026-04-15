const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { generateInvoiceCode } = require('../utils/sequenceCode');

const genId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// ─── GROUPS ──────────────────────────────────────────────────

// GET /api/utility/groups
router.get('/groups', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT g.id, g.name, g.property_id, g.status,
              p.display_name AS property_name,
              (SELECT COUNT(*) FROM utility_meter m WHERE m.group_id = g.id AND m.status = 1) AS meter_count
       FROM utility_group g
       LEFT JOIN property p ON g.property_id = p.id
       WHERE g.org_id = ? AND g.status = 1
       ORDER BY g.name`,
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('List utility groups error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list utility groups' });
  }
});

// POST /api/utility/group
router.post('/group', authenticate, async (req, res) => {
  try {
    const { name, property_id } = req.body;
    const orgId = req.user.orgId;
    if (!name) return res.status(400).json({ code: 400, message: 'Name is required' });

    const id = genId();
    await req.pool.execute(
      'INSERT INTO utility_group (id, org_id, name, property_id, status) VALUES (?, ?, ?, ?, 1)',
      [id, orgId, name, property_id || null]
    );
    res.json({ code: 200, message: 'Group created', data: { id } });
  } catch (error) {
    console.error('Create utility group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create group' });
  }
});

// PUT /api/utility/group/:id
router.put('/group/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, property_id } = req.body;
    const orgId = req.user.orgId;

    const fields = [];
    const params = [];
    if (name !== undefined) { fields.push('name = ?'); params.push(name); }
    if (property_id !== undefined) { fields.push('property_id = ?'); params.push(property_id || null); }
    if (fields.length === 0) return res.status(400).json({ code: 400, message: 'Nothing to update' });

    params.push(id, orgId);
    await req.pool.execute(`UPDATE utility_group SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`, params);
    res.json({ code: 200, message: 'Group updated' });
  } catch (error) {
    console.error('Update utility group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update group' });
  }
});

// GET /api/utility/properties-units — properties with units + current tenant names
router.get('/properties-units', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const today = new Date().toISOString().split('T')[0];

    const [rows] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.property_id,
              p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM unit u
       JOIN property p ON u.property_id = p.id AND p.org_id = ?
       LEFT JOIN leasing l ON l.unit_id = u.id AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL) AND l.deleted_at IS NULL
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE u.active_status = 1
       ORDER BY p.display_name, u.name`,
      [orgId, today, today]
    );

    // Deduplicate (in case multiple active leases, take first)
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = r.unit_id.toString();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }

    // Group by property
    const propertyMap = {};
    for (const r of deduped) {
      const pid = r.property_id.toString();
      if (!propertyMap[pid]) {
        propertyMap[pid] = { id: r.property_id, display_name: r.property_name, units: [] };
      }
      const tenant = [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ');
      propertyMap[pid].units.push({
        id: r.unit_id,
        name: r.unit_name,
        tenant_name: tenant || null,
      });
    }

    res.json({ code: 200, data: Object.values(propertyMap) });
  } catch (error) {
    console.error('Get properties-units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load properties and units' });
  }
});

// GET /api/utility/unit-groups — get all unit→group assignments
router.get('/unit-groups', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT uug.unit_id, uug.group_id
       FROM utility_unit_group uug
       JOIN unit u ON uug.unit_id = u.id
       JOIN property p ON u.property_id = p.id AND p.org_id = ?`,
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get unit-groups error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load unit group assignments' });
  }
});

// POST /api/utility/unit-groups/assign — bulk-assign units to groups
// body: { assignments: [{ unit_id, group_id }, ...] }
router.post('/unit-groups/assign', authenticate, async (req, res) => {
  try {
    const { assignments } = req.body;
    const orgId = req.user.orgId;
    if (!Array.isArray(assignments)) {
      return res.status(400).json({ code: 400, message: 'assignments array is required' });
    }

    // Get all unit IDs belonging to this org
    const [orgUnits] = await req.pool.execute(
      `SELECT u.id FROM unit u JOIN property p ON u.property_id = p.id AND p.org_id = ?`,
      [orgId]
    );
    const orgUnitIds = new Set(orgUnits.map(u => u.id.toString()));

    // Delete existing assignments for this org's units
    if (orgUnitIds.size > 0) {
      await req.pool.execute(
        `DELETE uug FROM utility_unit_group uug
         JOIN unit u ON uug.unit_id = u.id
         JOIN property p ON u.property_id = p.id AND p.org_id = ?`,
        [orgId]
      );
    }

    // Insert new assignments
    for (const { unit_id, group_id } of assignments) {
      if (unit_id && group_id && orgUnitIds.has(unit_id.toString())) {
        await req.pool.execute(
          'INSERT INTO utility_unit_group (unit_id, group_id) VALUES (?, ?)',
          [unit_id, group_id]
        );
      }
    }

    res.json({ code: 200, message: 'Unit group assignments saved' });
  } catch (error) {
    console.error('Assign units to groups error:', error);
    res.status(500).json({ code: 500, message: 'Failed to save assignments' });
  }
});

// DELETE /api/utility/group/:id
router.delete('/group/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Check for linked bills
    const [[{ cnt }]] = await req.pool.execute(
      'SELECT COUNT(*) as cnt FROM utility_bill WHERE group_id = ? AND org_id = ?',
      [id, orgId]
    );
    if (Number(cnt) > 0) {
      return res.status(400).json({
        code: 400,
        message: `Cannot delete: group has ${cnt} bill(s). Delete the bills first.`
      });
    }

    // Delete meters in group first
    await req.pool.execute('UPDATE utility_meter SET status = 0 WHERE group_id = ? AND org_id = ?', [id, orgId]);
    await req.pool.execute('UPDATE utility_group SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Group deleted' });
  } catch (error) {
    console.error('Delete utility group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete group' });
  }
});

// ─── METERS ──────────────────────────────────────────────────

// GET /api/utility/meters?group_id=
router.get('/meters', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { group_id } = req.query;
    const today = new Date().toISOString().split('T')[0];

    let sql = `SELECT m.id, m.group_id, m.unit_id, m.meter_number, m.meter_type,
                      m.meter_category, m.current_reading, m.status,
                      g.name AS group_name,
                      u.name AS unit_name,
                      p.display_name AS property_name,
                      lr.reading_value AS last_reading,
                      lr.reading_date AS last_reading_date,
                      lr.reading_type AS last_reading_type,
                      t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                      t.id AS tenant_id, l.id AS leasing_id,
                      l.end_date AS lease_end_date,
                      CASE WHEN l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL) THEN 1 ELSE 0 END AS is_current_tenant
               FROM utility_meter m
               LEFT JOIN utility_group g ON m.group_id = g.id
               LEFT JOIN unit u ON m.unit_id = u.id
               LEFT JOIN property p ON u.property_id = p.id
               LEFT JOIN (
                 SELECT meter_id, reading_value, reading_date, reading_type,
                        ROW_NUMBER() OVER (PARTITION BY meter_id ORDER BY reading_date DESC, created_at DESC) AS rn
                 FROM utility_meter_reading
               ) lr ON lr.meter_id = m.id AND lr.rn = 1
               LEFT JOIN (
                 SELECT unit_id, tenant_id, id, end_date, start_date, deleted_at,
                        ROW_NUMBER() OVER (PARTITION BY unit_id ORDER BY start_date DESC) AS rn
                 FROM leasing WHERE deleted_at IS NULL
               ) l ON l.unit_id = m.unit_id AND m.unit_id IS NOT NULL AND l.rn = 1
               LEFT JOIN tenant t ON l.tenant_id = t.id
               WHERE m.org_id = ? AND m.status = 1`;
    const params = [today, today, orgId];

    if (group_id) {
      sql += ' AND m.group_id = ?';
      params.push(group_id);
    }
    sql += ' ORDER BY g.name, m.meter_category, u.name, m.meter_number';

    const [rows] = await req.pool.execute(sql, params);
    // Deduplicate in case of multiple active leases
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = r.id.toString();
      if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    }
    res.json({ code: 200, data: deduped });
  } catch (error) {
    console.error('List utility meters error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list meters' });
  }
});

// POST /api/utility/meter
router.post('/meter', authenticate, async (req, res) => {
  try {
    const { group_id, unit_id, meter_number, meter_type, meter_category, current_reading } = req.body;
    const orgId = req.user.orgId;
    if (!group_id || !meter_number) {
      return res.status(400).json({ code: 400, message: 'Group and meter number are required' });
    }

    const cat = meter_category ?? 1; // default sub-meter

    // Enforce max 1 master meter per group
    if (Number(cat) === 0) {
      const [[{ cnt }]] = await req.pool.execute(
        'SELECT COUNT(*) as cnt FROM utility_meter WHERE group_id = ? AND org_id = ? AND meter_category = 0 AND status = 1',
        [group_id, orgId]
      );
      if (Number(cnt) > 0) {
        return res.status(400).json({ code: 400, message: 'This group already has a master meter. Only one master meter per group is allowed.' });
      }
    }

    const id = genId();
    const initialReading = current_reading ?? 0;
    await req.pool.execute(
      `INSERT INTO utility_meter (id, org_id, group_id, unit_id, meter_number, meter_type, meter_category, current_reading, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, orgId, group_id, unit_id || null, meter_number, meter_type ?? 0, cat, initialReading]
    );

    // Log initial reading if > 0
    if (Number(initialReading) > 0) {
      const readingId = genId();
      await req.pool.execute(
        `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, notes)
         VALUES (?, ?, ?, ?, CURDATE(), 2, 'Initial meter reading')`,
        [readingId, orgId, id, initialReading]
      );
    }

    res.json({ code: 200, message: 'Meter created', data: { id } });
  } catch (error) {
    console.error('Create utility meter error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create meter' });
  }
});

// PUT /api/utility/meter/:id
router.put('/meter/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { group_id, unit_id, meter_number, meter_type, meter_category } = req.body;
    const orgId = req.user.orgId;

    const fields = [];
    const params = [];
    if (group_id !== undefined) { fields.push('group_id = ?'); params.push(group_id); }
    if (unit_id !== undefined) { fields.push('unit_id = ?'); params.push(unit_id || null); }
    if (meter_number !== undefined) { fields.push('meter_number = ?'); params.push(meter_number); }
    if (meter_type !== undefined) { fields.push('meter_type = ?'); params.push(meter_type); }
    if (meter_category !== undefined) { fields.push('meter_category = ?'); params.push(meter_category); }
    if (fields.length === 0) return res.status(400).json({ code: 400, message: 'Nothing to update' });

    params.push(id, orgId);
    await req.pool.execute(`UPDATE utility_meter SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`, params);
    res.json({ code: 200, message: 'Meter updated' });
  } catch (error) {
    console.error('Update utility meter error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update meter' });
  }
});

// DELETE /api/utility/meter/:id
router.delete('/meter/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Check for linked bill lines
    const [[{ cnt }]] = await req.pool.execute(
      'SELECT COUNT(*) as cnt FROM utility_bill_line WHERE meter_id = ?',
      [id]
    );
    if (Number(cnt) > 0) {
      return res.status(400).json({
        code: 400,
        message: `Cannot delete: meter has ${cnt} bill record(s).`
      });
    }

    await req.pool.execute('UPDATE utility_meter SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Meter deleted' });
  } catch (error) {
    console.error('Delete utility meter error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete meter' });
  }
});

// ─── METER READINGS ─────────────────────────────────────────

// POST /api/utility/meter-reading — log a move-in/move-out/manual reading
router.post('/meter-reading', authenticate, async (req, res) => {
  try {
    const { meter_id, reading_value, reading_date, reading_type, tenant_id, notes } = req.body;
    const orgId = req.user.orgId;

    if (!meter_id || reading_value == null) {
      return res.status(400).json({ code: 400, message: 'Meter and reading value are required' });
    }

    // Verify meter belongs to org
    const [[meter]] = await req.pool.execute(
      'SELECT id, current_reading FROM utility_meter WHERE id = ? AND org_id = ? AND status = 1',
      [meter_id, orgId]
    );
    if (!meter) return res.status(404).json({ code: 404, message: 'Meter not found' });

    // Get last reading for comparison
    const [[lastReading]] = await req.pool.execute(
      `SELECT reading_value FROM utility_meter_reading WHERE meter_id = ? ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
      [meter_id]
    );

    const warning = lastReading && Number(reading_value) < Number(lastReading.reading_value)
      ? `Warning: new reading (${reading_value}) is less than last reading (${lastReading.reading_value})`
      : null;

    const id = genId();
    await req.pool.execute(
      `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, tenant_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, orgId, meter_id, reading_value, reading_date || new Date().toISOString().split('T')[0], reading_type ?? 0, tenant_id || null, notes || null]
    );

    // Also update current_reading on meter for backward compat
    await req.pool.execute('UPDATE utility_meter SET current_reading = ? WHERE id = ?', [reading_value, meter_id]);

    // If Move-Out reading (type 1), sync to the most recent lease's check_out_meter
    if (Number(reading_type) === 1) {
      const [[meterUnit]] = await req.pool.execute('SELECT unit_id FROM utility_meter WHERE id = ?', [meter_id]);
      if (meterUnit?.unit_id) {
        // Find the most recent lease for this unit (active or ended)
        const [[activeLease]] = await req.pool.execute(
          `SELECT id FROM leasing WHERE unit_id = ? AND deleted_at IS NULL
           ORDER BY start_date DESC LIMIT 1`,
          [meterUnit.unit_id]
        );
        if (activeLease) {
          await req.pool.execute(
            'UPDATE leasing SET check_out_meter = ?, check_out_meter_updated_at = NOW() WHERE id = ?',
            [reading_value, activeLease.id]
          );
        }
      }
    }

    // If Move-In reading (type 0), sync to the most recent lease's check_in_meter
    if (Number(reading_type) === 0) {
      const [[meterUnit2]] = await req.pool.execute('SELECT unit_id FROM utility_meter WHERE id = ?', [meter_id]);
      if (meterUnit2?.unit_id) {
        const [[activeLease2]] = await req.pool.execute(
          `SELECT id FROM leasing WHERE unit_id = ? AND deleted_at IS NULL
           ORDER BY start_date DESC LIMIT 1`,
          [meterUnit2.unit_id]
        );
        if (activeLease2) {
          await req.pool.execute(
            'UPDATE leasing SET check_in_meter = ?, check_in_meter_updated_at = NOW() WHERE id = ?',
            [reading_value, activeLease2.id]
          );
        }
      }
    }

    res.json({ code: 200, message: 'Reading logged', data: { id, warning } });
  } catch (error) {
    console.error('Log meter reading error:', error);
    res.status(500).json({ code: 500, message: 'Failed to log reading' });
  }
});

// GET /api/utility/meter-readings?meter_id= — reading history for a meter
router.get('/meter-readings', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { meter_id } = req.query;
    if (!meter_id) return res.status(400).json({ code: 400, message: 'meter_id is required' });

    const [rows] = await req.pool.execute(
      `SELECT r.id, r.reading_value, r.reading_date, r.reading_type, r.notes, r.bill_id, r.created_at,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM utility_meter_reading r
       LEFT JOIN tenant t ON r.tenant_id = t.id
       WHERE r.meter_id = ? AND r.org_id = ?
       ORDER BY r.reading_date DESC, r.created_at DESC`,
      [meter_id, orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get meter readings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get readings' });
  }
});

// GET /api/utility/unit-readings?unit_id= — all readings for a unit's meters
router.get('/unit-readings', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { unit_id } = req.query;
    if (!unit_id) return res.status(400).json({ code: 400, message: 'unit_id is required' });

    const [rows] = await req.pool.execute(
      `SELECT r.id, r.reading_value, r.reading_date, r.reading_type, r.notes, r.bill_id, r.created_at,
              m.meter_number,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM utility_meter_reading r
       JOIN utility_meter m ON r.meter_id = m.id
       LEFT JOIN tenant t ON r.tenant_id = t.id
       WHERE m.unit_id = ? AND r.org_id = ?
       ORDER BY r.reading_date DESC, r.created_at DESC`,
      [unit_id, orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get unit readings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get unit readings' });
  }
});

// ─── BILLS ──────────────────────────────────────────────────

// GET /api/utility/last-bill-date?group_id= — get last bill's end date for auto-fill
router.get('/last-bill-date', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { group_id } = req.query;
    if (!group_id) return res.json({ code: 200, data: null });

    const [rows] = await req.pool.execute(
      `SELECT period_end FROM utility_bill
       WHERE org_id = ? AND group_id = ?
       ORDER BY period_end DESC LIMIT 1`,
      [orgId, group_id]
    );

    if (rows.length > 0) {
      // Return the day after the last bill's end date
      const lastEnd = new Date(rows[0].period_end);
      lastEnd.setDate(lastEnd.getDate() + 1);
      const nextStart = lastEnd.toISOString().split('T')[0];
      res.json({ code: 200, data: { last_end: rows[0].period_end, next_start: nextStart } });
    } else {
      res.json({ code: 200, data: null });
    }
  } catch (error) {
    console.error('Get last bill date error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get last bill date' });
  }
});

// GET /api/utility/bills?group_id=
router.get('/bills', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { group_id } = req.query;

    let sql = `SELECT b.id, b.group_id, b.period_start, b.period_end,
                      b.total_amount, b.total_kw, b.rate_per_kw, b.status,
                      g.name AS group_name,
                      (SELECT COUNT(*) FROM utility_bill_line bl WHERE bl.bill_id = b.id AND bl.is_common_area = 0 AND bl.invoice_id IS NOT NULL) AS invoices_generated
               FROM utility_bill b
               LEFT JOIN utility_group g ON b.group_id = g.id
               WHERE b.org_id = ?`;
    const params = [orgId];

    if (group_id) {
      sql += ' AND b.group_id = ?';
      params.push(group_id);
    }
    sql += ' ORDER BY b.period_start DESC';

    const [rows] = await req.pool.execute(sql, params);
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('List utility bills error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list bills' });
  }
});

// GET /api/utility/bill/:id — get bill with all lines
router.get('/bill/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[bill]] = await req.pool.execute(
      `SELECT b.*, g.name AS group_name
       FROM utility_bill b
       LEFT JOIN utility_group g ON b.group_id = g.id
       WHERE b.id = ? AND b.org_id = ?`,
      [id, orgId]
    );
    if (!bill) return res.status(404).json({ code: 404, message: 'Bill not found' });

    const [lines] = await req.pool.execute(
      `SELECT bl.*,
              m.meter_number, m.meter_type, m.meter_category,
              u.name AS unit_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              p.display_name AS property_name,
              i.invoice_code, i.status AS invoice_status
       FROM utility_bill_line bl
       LEFT JOIN utility_meter m ON bl.meter_id = m.id
       LEFT JOIN unit u ON bl.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON bl.tenant_id = t.id
       LEFT JOIN invoice i ON bl.invoice_id = i.id
       WHERE bl.bill_id = ?
       ORDER BY bl.is_common_area, u.name, m.meter_number`,
      [id]
    );

    res.json({ code: 200, data: { ...bill, lines } });
  } catch (error) {
    console.error('Get utility bill error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get bill' });
  }
});

// POST /api/utility/bill — create a new bill and auto-generate lines from group meters
router.post('/bill', authenticate, async (req, res) => {
  try {
    const { group_id, period_start, period_end, total_amount, total_kw } = req.body;
    const orgId = req.user.orgId;

    if (!group_id || !period_start || !period_end || total_amount == null || total_kw == null) {
      return res.status(400).json({ code: 400, message: 'Group, period dates, total amount and total kW are required' });
    }
    if (Number(total_kw) === 0) {
      return res.status(400).json({ code: 400, message: 'Total kW cannot be zero' });
    }

    // Check for overlapping bills in this group
    const [[{ overlap }]] = await req.pool.execute(
      `SELECT COUNT(*) as overlap FROM utility_bill
       WHERE org_id = ? AND group_id = ? AND period_start <= ? AND period_end >= ?`,
      [orgId, group_id, period_end, period_start]
    );
    if (Number(overlap) > 0) {
      return res.status(400).json({ code: 400, message: 'Cannot create bill: dates overlap with an existing bill for this group.' });
    }

    const ratePerKw = Number(total_amount) / Number(total_kw);
    const billId = genId();

    await req.pool.execute(
      `INSERT INTO utility_bill (id, org_id, group_id, period_start, period_end, total_amount, total_kw, rate_per_kw, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [billId, orgId, group_id, period_start, period_end, total_amount, total_kw, (Math.ceil(ratePerKw * 100) / 100).toFixed(2)]
    );

    // Get active sub-meters in this group (category=1 only; master meter is bill-level)
    const [meters] = await req.pool.execute(
      `SELECT m.id, m.unit_id, m.meter_number, m.meter_type, m.meter_category, m.current_reading
       FROM utility_meter m
       WHERE m.group_id = ? AND m.org_id = ? AND m.status = 1 AND m.meter_category = 1
       ORDER BY m.unit_id, m.meter_number`,
      [group_id, orgId]
    );

    // Create a bill line for each sub-meter
    const totalDays = daysBetween(period_start, period_end);

    for (const meter of meters) {
      const isCommon = meter.unit_id == null ? 1 : 0;

      // Get last reading — check both meter_reading log AND the ending_reading from the most recent
      // finalized bill line for this meter (whichever is higher), so that creating a new bill after
      // finalizing the previous one always picks up the correct starting value.
      const [[lastReading]] = await req.pool.execute(
        `SELECT reading_value FROM utility_meter_reading WHERE meter_id = ? ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
        [meter.id]
      );
      const [[lastBillLine]] = await req.pool.execute(
        `SELECT bl.ending_reading FROM utility_bill_line bl
         JOIN utility_bill b ON bl.bill_id = b.id
         WHERE bl.meter_id = ? AND b.status = 1
         ORDER BY b.period_end DESC LIMIT 1`,
        [meter.id]
      );
      // Use the highest value among: last reading log, last finalized bill ending, or meter current_reading
      const candidates = [
        lastReading ? Number(lastReading.reading_value) : 0,
        lastBillLine ? Number(lastBillLine.ending_reading) : 0,
        Number(meter.current_reading) || 0
      ];
      const startReading = Math.max(...candidates);
      let tenantId = null;
      let leasingId = null;
      let leaseStart = null;
      let leaseEnd = null;
      let utilityCredit = 0;

      // Find tenant with an active lease at the END of the billing period.
      // If a tenant checked out mid-period, they would have been settled via
      // checkout settlement already — so only include tenants still active at period_end.
      if (!isCommon && meter.unit_id) {
        const [[lease]] = await req.pool.execute(
          `SELECT l.id, l.tenant_id, l.start_date, l.end_date, l.utility_credit
           FROM leasing l
           WHERE l.unit_id = ? AND l.deleted_at IS NULL
             AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
           ORDER BY l.start_date DESC LIMIT 1`,
          [meter.unit_id, period_end, period_end]
        );
        if (lease) {
          tenantId = lease.tenant_id;
          leasingId = lease.id;
          leaseStart = lease.start_date;
          leaseEnd = lease.end_date;
          utilityCredit = Number(lease.utility_credit) || 0;
        }
      }

      const lineId = genId();
      await req.pool.execute(
        `INSERT INTO utility_bill_line
         (id, bill_id, meter_id, unit_id, tenant_id, leasing_id,
          starting_reading, ending_reading, kw_used, gross_amount,
          utility_credit, lease_start, lease_end, prorated_days, total_period_days, prorated_credit, net_amount,
          is_common_area)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, 0, 0, ?)`,
        [lineId, billId, meter.id, meter.unit_id || null, tenantId, leasingId,
         startReading, utilityCredit,
         leaseStart, leaseEnd, totalDays, totalDays, isCommon]
      );
    }

    res.json({ code: 200, message: 'Bill created', data: { id: billId, rate_per_kw: (Math.ceil(ratePerKw * 100) / 100).toFixed(2) } });
  } catch (error) {
    console.error('Create utility bill error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create bill' });
  }
});

// PUT /api/utility/bill/:id — update bill header (recalculates rate)
router.put('/bill/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { total_amount, total_kw, period_start, period_end } = req.body;
    const orgId = req.user.orgId;

    const [[bill]] = await req.pool.execute(
      'SELECT * FROM utility_bill WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!bill) return res.status(404).json({ code: 404, message: 'Bill not found' });
    if (Number(bill.status) === 1) {
      return res.status(400).json({ code: 400, message: 'Cannot edit a finalized bill' });
    }

    const newAmount = total_amount ?? bill.total_amount;
    const newKw = total_kw ?? bill.total_kw;
    const newStart = period_start ?? bill.period_start;
    const newEnd = period_end ?? bill.period_end;

    if (Number(newKw) === 0) {
      return res.status(400).json({ code: 400, message: 'Total kW cannot be zero' });
    }

    const ratePerKw = Number(newAmount) / Number(newKw);

    await req.pool.execute(
      `UPDATE utility_bill SET total_amount = ?, total_kw = ?, rate_per_kw = ?, period_start = ?, period_end = ?
       WHERE id = ? AND org_id = ?`,
      [newAmount, newKw, (Math.ceil(ratePerKw * 100) / 100).toFixed(2), newStart, newEnd, id, orgId]
    );

    res.json({ code: 200, message: 'Bill updated', data: { rate_per_kw: (Math.ceil(ratePerKw * 100) / 100).toFixed(2) } });
  } catch (error) {
    console.error('Update utility bill error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update bill' });
  }
});

// PUT /api/utility/bill-line/:id — update a bill line's ending reading (recalculates amounts)
router.put('/bill-line/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { ending_reading } = req.body;
    const orgId = req.user.orgId;

    if (ending_reading == null) {
      return res.status(400).json({ code: 400, message: 'Ending reading is required' });
    }

    // Get the line and its bill
    const [[line]] = await req.pool.execute(
      `SELECT bl.*, b.rate_per_kw, b.period_start, b.period_end, b.status AS bill_status
       FROM utility_bill_line bl
       JOIN utility_bill b ON bl.bill_id = b.id
       WHERE bl.id = ? AND b.org_id = ?`,
      [id, orgId]
    );
    if (!line) return res.status(404).json({ code: 404, message: 'Bill line not found' });
    if (Number(line.bill_status) === 1) {
      return res.status(400).json({ code: 400, message: 'Cannot edit lines on a finalized bill' });
    }

    const startReading = Number(line.starting_reading);
    const endReading = Number(ending_reading);
    const kwUsed = Math.max(0, endReading - startReading);
    const ratePerKw = Number(line.rate_per_kw);
    const grossAmount = kwUsed * ratePerKw;

    // Calculate prorated credit
    let proratedCredit = 0;
    const monthlyCredit = Number(line.utility_credit) || 0;
    const totalPeriodDays = daysBetween(line.period_start, line.period_end);

    if (monthlyCredit > 0 && !Number(line.is_common_area) && line.tenant_id) {
      // Determine overlapping days between lease and billing period
      const billStart = new Date(line.period_start);
      const billEnd = new Date(line.period_end);
      const leaseStart = line.lease_start ? new Date(line.lease_start) : billStart;
      const leaseEnd = line.lease_end ? new Date(line.lease_end) : billEnd;

      const overlapStart = leaseStart > billStart ? leaseStart : billStart;
      const overlapEnd = leaseEnd < billEnd ? leaseEnd : billEnd;
      const overlapDays = daysBetween(overlapStart, overlapEnd);

      if (overlapDays > 0) {
        // Prorate: (monthly_credit * 12 / 365) * overlapping_days
        proratedCredit = Math.round((monthlyCredit * 12 / 365) * overlapDays * 100) / 100;
      }
    }

    const netAmount = Math.max(0, grossAmount - proratedCredit);
    const proratedDays = monthlyCredit > 0 && !Number(line.is_common_area) ? (() => {
      const billStart = new Date(line.period_start);
      const billEnd = new Date(line.period_end);
      const leaseStart = line.lease_start ? new Date(line.lease_start) : billStart;
      const leaseEnd = line.lease_end ? new Date(line.lease_end) : billEnd;
      const overlapStart = leaseStart > billStart ? leaseStart : billStart;
      const overlapEnd = leaseEnd < billEnd ? leaseEnd : billEnd;
      return daysBetween(overlapStart, overlapEnd);
    })() : totalPeriodDays;

    await req.pool.execute(
      `UPDATE utility_bill_line
       SET ending_reading = ?, kw_used = ?, gross_amount = ?,
           prorated_days = ?, total_period_days = ?, prorated_credit = ?, net_amount = ?
       WHERE id = ?`,
      [ending_reading, kwUsed, grossAmount.toFixed(2), proratedDays, totalPeriodDays, proratedCredit.toFixed(2), netAmount.toFixed(2), id]
    );

    res.json({
      code: 200,
      message: 'Line updated',
      data: { kw_used: kwUsed, gross_amount: grossAmount.toFixed(2), prorated_credit: proratedCredit.toFixed(2), net_amount: netAmount.toFixed(2), prorated_days: proratedDays }
    });
  } catch (error) {
    console.error('Update utility bill line error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update bill line' });
  }
});

// POST /api/utility/bill/:id/finalize — finalize bill + update meter current_readings
router.post('/bill/:id/finalize', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[bill]] = await req.pool.execute(
      'SELECT * FROM utility_bill WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!bill) return res.status(404).json({ code: 404, message: 'Bill not found' });
    if (Number(bill.status) === 1) {
      return res.status(400).json({ code: 400, message: 'Bill is already finalized' });
    }

    // Verify all lines have ending readings
    const [[{ unfinished }]] = await req.pool.execute(
      'SELECT COUNT(*) as unfinished FROM utility_bill_line WHERE bill_id = ? AND ending_reading = 0 AND is_common_area = 0',
      [id]
    );
    if (Number(unfinished) > 0) {
      return res.status(400).json({ code: 400, message: `${unfinished} meter(s) still have no ending reading` });
    }

    // Log ending readings into utility_meter_reading and update current_reading
    const [lines] = await req.pool.execute(
      'SELECT id, meter_id, ending_reading, tenant_id FROM utility_bill_line WHERE bill_id = ?', [id]
    );
    for (const line of lines) {
      // Insert reading log entry
      const readingId = genId();
      await req.pool.execute(
        `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, tenant_id, bill_id)
         VALUES (?, ?, ?, ?, ?, 2, ?, ?)`,
        [readingId, orgId, line.meter_id, line.ending_reading, bill.period_end, line.tenant_id || null, id]
      );
      // Also update current_reading for backward compat
      await req.pool.execute(
        'UPDATE utility_meter SET current_reading = ? WHERE id = ?',
        [line.ending_reading, line.meter_id]
      );
    }

    await req.pool.execute('UPDATE utility_bill SET status = 1 WHERE id = ?', [id]);
    res.json({ code: 200, message: 'Bill finalized' });
  } catch (error) {
    console.error('Finalize utility bill error:', error);
    res.status(500).json({ code: 500, message: 'Failed to finalize bill' });
  }
});

// POST /api/utility/bill/:id/generate-invoices — create invoices for lines with net > 0
router.post('/bill/:id/generate-invoices', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[bill]] = await req.pool.execute(
      'SELECT * FROM utility_bill WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!bill) return res.status(404).json({ code: 404, message: 'Bill not found' });
    if (Number(bill.status) !== 1) {
      return res.status(400).json({ code: 400, message: 'Bill must be finalized before generating invoices' });
    }

    // Get eligible lines — optionally filtered by line_ids for selective generation
    const { line_ids } = req.body || {};

    let lineSql = `SELECT bl.*, m.meter_number
       FROM utility_bill_line bl
       LEFT JOIN utility_meter m ON bl.meter_id = m.id
       WHERE bl.bill_id = ? AND bl.is_common_area = 0 AND bl.net_amount > 0 AND bl.invoice_id IS NULL AND bl.tenant_id IS NOT NULL`;
    const lineParams = [id];

    if (Array.isArray(line_ids) && line_ids.length > 0) {
      const placeholders = line_ids.map(() => '?').join(',');
      lineSql += ` AND bl.id IN (${placeholders})`;
      lineParams.push(...line_ids);
    }

    const [lines] = await req.pool.execute(lineSql, lineParams);

    if (lines.length === 0) {
      return res.json({ code: 200, message: 'No invoices to generate', data: { count: 0 } });
    }

    // Get default currency
    const [[cur]] = await req.pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
    const currencyId = cur ? cur.id : null;

    // Get utility category — prefer exact "Utilities", then "Utility", then fallback
    let categoryId = null;
    const [[exactCat]] = await req.pool.execute(
      "SELECT id FROM category_setting WHERE org_id = ? AND (name = 'Utilities' OR name = 'utilities') ORDER BY id LIMIT 1",
      [orgId]
    );
    if (exactCat) {
      categoryId = exactCat.id;
    } else {
      const [[utilityCat]] = await req.pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND (name = 'Utility' OR name = 'utility') ORDER BY id LIMIT 1",
        [orgId]
      );
      if (utilityCat) {
        categoryId = utilityCat.id;
      } else {
        const [[defCat]] = await req.pool.execute(
          "SELECT id FROM category_setting WHERE org_id = ? ORDER BY id LIMIT 1",
          [orgId]
        );
        categoryId = defCat ? defCat.id : 0;
      }
    }

    let created = 0;
    for (const line of lines) {
      const invoiceId = genId();
      const invoiceCode = await generateInvoiceCode(req.pool, orgId);

      // Find property_id from unit
      let propertyId = null;
      if (line.unit_id) {
        const [[unit]] = await req.pool.execute('SELECT property_id FROM unit WHERE id = ?', [line.unit_id]);
        if (unit) propertyId = unit.property_id;
      }

      const note = `Utility charge: ${line.kw_used} kW × $${Number(bill.rate_per_kw).toFixed(4)}/kW = $${Number(line.gross_amount).toFixed(2)}` +
        (Number(line.prorated_credit) > 0 ? ` | Credit: -$${Number(line.prorated_credit).toFixed(2)}` : '') +
        ` | Meter: ${line.meter_number || 'N/A'}` +
        ` | Period: ${bill.period_start} to ${bill.period_end}`;

      await req.pool.execute(
        `INSERT INTO invoice (id, org_id, invoice_code, property_id, unit_id, leasing_id, tenant_id,
         currency_id, due_on, category, amount, note, type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW())`,
        [invoiceId, orgId, invoiceCode, propertyId, line.unit_id || null, line.leasing_id || null,
         line.tenant_id, currencyId, bill.period_end, categoryId,
         Math.ceil(Number(line.net_amount)), note]
      );

      // Link invoice to bill line
      await req.pool.execute('UPDATE utility_bill_line SET invoice_id = ? WHERE id = ?', [invoiceId, line.id]);
      created++;
    }

    res.json({ code: 200, message: `${created} invoice(s) generated`, data: { count: created } });
  } catch (error) {
    console.error('Generate utility invoices error:', error);
    res.status(500).json({ code: 500, message: 'Failed to generate invoices' });
  }
});

// DELETE /api/utility/bill/:id
router.delete('/bill/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[bill]] = await req.pool.execute(
      'SELECT status FROM utility_bill WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!bill) return res.status(404).json({ code: 404, message: 'Bill not found' });

    // Check if any invoices were generated (exclude soft-deleted invoices)
    const [[{ cnt }]] = await req.pool.execute(
      `SELECT COUNT(*) as cnt FROM utility_bill_line bl
       JOIN invoice i ON i.id = bl.invoice_id
       WHERE bl.bill_id = ? AND bl.invoice_id IS NOT NULL AND i.deleted_at IS NULL`,
      [id]
    );
    if (Number(cnt) > 0) {
      return res.status(400).json({
        code: 400,
        message: `Cannot delete: ${cnt} active invoice(s) have been generated from this bill. Delete them first.`
      });
    }

    await req.pool.execute('DELETE FROM utility_bill_line WHERE bill_id = ?', [id]);
    await req.pool.execute('DELETE FROM utility_bill WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Bill deleted' });
  } catch (error) {
    console.error('Delete utility bill error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete bill' });
  }
});

// GET /api/utility/report — 6-month report: groups → bills → per-unit lines
router.get('/report', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    // Get all active groups
    const [groups] = await req.pool.execute(
      `SELECT g.id, g.name FROM utility_group g WHERE g.org_id = ? AND g.status = 1 ORDER BY g.name`,
      [orgId]
    );

    const result = [];

    for (const group of groups) {
      // Get last 6 finalized bills for this group
      const [bills] = await req.pool.execute(
        `SELECT id, period_start, period_end, total_amount, total_kw, rate_per_kw
         FROM utility_bill
         WHERE org_id = ? AND group_id = ? AND status = 1
         ORDER BY period_end DESC LIMIT 6`,
        [orgId, group.id]
      );

      if (bills.length === 0) continue;

      // Get all bill lines for these bills
      const billIds = bills.map(b => b.id);
      const placeholders = billIds.map(() => '?').join(',');
      const [lines] = await req.pool.execute(
        `SELECT bl.*, m.meter_number,
                u.name AS unit_name, u.property_id,
                p.display_name AS property_name,
                t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                i.status AS invoice_status, i.invoice_code
         FROM utility_bill_line bl
         LEFT JOIN utility_meter m ON bl.meter_id = m.id
         LEFT JOIN unit u ON bl.unit_id = u.id
         LEFT JOIN property p ON u.property_id = p.id
         LEFT JOIN tenant t ON bl.tenant_id = t.id
         LEFT JOIN invoice i ON bl.invoice_id = i.id
         WHERE bl.bill_id IN (${placeholders})
         ORDER BY u.name`,
        billIds
      );

      // Group lines by unit (meter)
      const unitMap = {};
      for (const line of lines) {
        if (Number(line.is_common_area)) continue;
        const key = line.meter_id?.toString() || line.id.toString();
        if (!unitMap[key]) {
          const tenant = [line.tenant_first_name, line.tenant_last_name].filter(Boolean).join(' ');
          unitMap[key] = {
            meter_id: line.meter_id,
            meter_number: line.meter_number,
            unit_name: line.unit_name,
            property_name: line.property_name,
            tenant_name: tenant || null,
            months: {},
          };
        }
        unitMap[key].months[line.bill_id.toString()] = {
          meter_reading: Number(line.ending_reading),
          kw_used: Number(line.kw_used),
          utility_credit: Number(line.prorated_credit),
          gross_amount: Number(line.gross_amount),
          fees_due: Math.max(0, Number(line.net_amount)),
          invoice_status: line.invoice_id ? Number(line.invoice_status) : null,
          invoice_code: line.invoice_code || null,
        };
      }

      result.push({
        group_id: group.id,
        group_name: group.name,
        bills: bills.map(b => ({
          id: b.id,
          period_start: b.period_start,
          period_end: b.period_end,
          total_amount: Number(b.total_amount),
          total_kw: Number(b.total_kw),
          rate_per_kw: Number(b.rate_per_kw),
        })),
        units: Object.values(unitMap),
      });
    }

    res.json({ code: 200, data: result });
  } catch (error) {
    console.error('Utility report error:', error);
    res.status(500).json({ code: 500, message: 'Failed to generate report' });
  }
});

// ─── HELPERS ─────────────────────────────────────────────────

// GET /api/utility/highest-rate?group_id= — highest $/kW rate from the last year
router.get('/highest-rate', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { group_id } = req.query;

    let sql = `SELECT MAX(rate_per_kw) AS highest_rate FROM utility_bill WHERE org_id = ? AND period_start >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`;
    const params = [orgId];

    if (group_id) {
      sql += ' AND group_id = ?';
      params.push(group_id);
    }

    const [[result]] = await req.pool.execute(sql, params);
    res.json({ code: 200, data: { highest_rate: result?.highest_rate ? Number(result.highest_rate) : null } });
  } catch (error) {
    console.error('Get highest rate error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get highest rate' });
  }
});

// POST /api/utility/checkout-settlement — early checkout settlement for a tenant
// GET /api/utility/checkout-meters — all sub-meters with all tenant leases (not just latest)
router.get('/checkout-meters', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT m.id AS meter_id, m.group_id, m.unit_id, m.meter_number, m.meter_type,
              m.meter_category, m.current_reading,
              g.name AS group_name,
              u.name AS unit_name,
              p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.id AS tenant_id, l.id AS leasing_id,
              l.start_date AS lease_start_date, l.end_date AS lease_end_date
       FROM utility_meter m
       JOIN utility_group g ON m.group_id = g.id
       LEFT JOIN unit u ON m.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       JOIN leasing l ON l.unit_id = m.unit_id AND l.deleted_at IS NULL
       JOIN tenant t ON l.tenant_id = t.id
       WHERE m.org_id = ? AND m.status = 1 AND m.meter_category = 1
       ORDER BY t.first_name, t.last_name, m.meter_number, l.start_date DESC`,
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get checkout meters error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load checkout meters' });
  }
});

router.post('/checkout-settlement', authenticate, async (req, res) => {
  try {
    const {
      meter_id, tenant_id, leasing_id,
      checkout_reading, manual_rate,
      reading_date
    } = req.body;
    const orgId = req.user.orgId;

    if (!meter_id || checkout_reading == null || !manual_rate || !tenant_id || !leasing_id) {
      return res.status(400).json({ code: 400, message: 'Meter, tenant, lease, checkout reading, and manual rate are required' });
    }

    // Get meter info
    const [[meter]] = await req.pool.execute(
      'SELECT id, unit_id, current_reading, group_id FROM utility_meter WHERE id = ? AND org_id = ? AND status = 1',
      [meter_id, orgId]
    );
    if (!meter) return res.status(404).json({ code: 404, message: 'Meter not found' });

    // Get lease info for credit + dates
    const [[lease]] = await req.pool.execute(
      'SELECT id, unit_id, start_date, end_date, utility_credit, tenant_id FROM leasing WHERE id = ? AND deleted_at IS NULL',
      [leasing_id]
    );
    if (!lease) return res.status(404).json({ code: 404, message: 'Lease not found' });

    // Get last reading as starting point
    const [[lastReading]] = await req.pool.execute(
      `SELECT reading_value, reading_date FROM utility_meter_reading
       WHERE meter_id = ? ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
      [meter_id]
    );
    const startReading = lastReading ? Number(lastReading.reading_value) : Number(meter.current_reading);
    const startDate = lastReading ? lastReading.reading_date : lease.start_date;

    // Calculate usage
    const kwUsed = Number(checkout_reading) - startReading;
    if (kwUsed < 0) {
      return res.status(400).json({ code: 400, message: 'Checkout reading cannot be less than the last reading' });
    }

    const grossAmount = kwUsed * Number(manual_rate);

    // Prorate credit: (monthly_credit * 12 / 365) * days
    const utilityCredit = Number(lease.utility_credit) || 0;
    const settlementDate = reading_date || new Date().toISOString().split('T')[0];
    const periodDays = daysBetween(startDate, settlementDate);
    const proratedCredit = utilityCredit > 0 ? Math.round((utilityCredit * 12 / 365) * periodDays * 100) / 100 : 0;
    const netAmount = Math.max(0, Math.round((grossAmount - proratedCredit) * 100) / 100);

    // 1. Log the checkout meter reading
    const readingId = genId();
    await req.pool.execute(
      `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, tenant_id, notes)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [readingId, orgId, meter_id, checkout_reading, settlementDate, tenant_id, 'Checkout settlement']
    );

    // 2. Update meter current_reading
    await req.pool.execute('UPDATE utility_meter SET current_reading = ? WHERE id = ?', [checkout_reading, meter_id]);

    // 3. Update current lease check_out_meter
    await req.pool.execute(
      'UPDATE leasing SET check_out_meter = ?, check_out_meter_updated_at = NOW() WHERE id = ?',
      [checkout_reading, leasing_id]
    );

    // 4. Update next tenant's check_in_meter (if there's a future lease on same unit)
    const [[nextLease]] = await req.pool.execute(
      `SELECT id FROM leasing WHERE unit_id = ? AND deleted_at IS NULL AND id != ? AND start_date >= ?
       ORDER BY start_date ASC LIMIT 1`,
      [lease.unit_id, leasing_id, settlementDate]
    );
    if (nextLease) {
      // Only update if the next lease's check_in_meter hasn't been manually edited more recently
      const [[nextLeaseData]] = await req.pool.execute(
        'SELECT check_in_meter_updated_at FROM leasing WHERE id = ?', [nextLease.id]
      );
      const shouldUpdate = !nextLeaseData?.check_in_meter_updated_at || new Date() > new Date(nextLeaseData.check_in_meter_updated_at);
      if (shouldUpdate) {
        await req.pool.execute(
          'UPDATE leasing SET check_in_meter = ?, check_in_meter_updated_at = NOW() WHERE id = ?',
          [checkout_reading, nextLease.id]
        );
      }
    }

    // 5. Auto-generate invoice for net amount due
    let invoiceId = null;
    let invoiceCode = null;
    if (netAmount > 0) {
      // Get default currency
      const [[cur]] = await req.pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
      const currencyId = cur ? cur.id : null;

      // Get utility category — prefer "Utilities", then "Utility", then fallback
      let categoryId = null;
      const [[exactCat]] = await req.pool.execute(
        "SELECT id FROM category_setting WHERE org_id = ? AND (name = 'Utilities' OR name = 'utilities') ORDER BY id LIMIT 1",
        [orgId]
      );
      if (exactCat) {
        categoryId = exactCat.id;
      } else {
        const [[utilityCat]] = await req.pool.execute(
          "SELECT id FROM category_setting WHERE org_id = ? AND (name = 'Utility' OR name = 'utility') ORDER BY id LIMIT 1",
          [orgId]
        );
        if (utilityCat) {
          categoryId = utilityCat.id;
        } else {
          const [[defCat]] = await req.pool.execute(
            "SELECT id FROM category_setting WHERE org_id = ? ORDER BY id LIMIT 1",
            [orgId]
          );
          categoryId = defCat ? defCat.id : 0;
        }
      }

      // Get property_id from unit
      let propertyId = null;
      if (meter.unit_id) {
        const [[unit]] = await req.pool.execute('SELECT property_id FROM unit WHERE id = ?', [meter.unit_id]);
        if (unit) propertyId = unit.property_id;
      }

      // Get meter number for the note
      const [[meterInfo]] = await req.pool.execute('SELECT meter_number FROM utility_meter WHERE id = ?', [meter_id]);
      const meterNumber = meterInfo?.meter_number || 'N/A';

      invoiceId = genId();
      invoiceCode = await generateInvoiceCode(req.pool, orgId);

      const note = `Utility checkout settlement: ${kwUsed} kW × $${Number(manual_rate).toFixed(4)}/kW = $${grossAmount.toFixed(2)}` +
        (proratedCredit > 0 ? ` | Credit: -$${proratedCredit.toFixed(2)}` : '') +
        ` | Meter: ${meterNumber}` +
        ` | Reading: ${startReading} → ${Number(checkout_reading)}`;

      await req.pool.execute(
        `INSERT INTO invoice (id, org_id, invoice_code, property_id, unit_id, leasing_id, tenant_id,
         currency_id, due_on, category, amount, note, type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW())`,
        [invoiceId, orgId, invoiceCode, propertyId, meter.unit_id || null, leasing_id,
         tenant_id, currencyId, settlementDate, categoryId,
         Math.ceil(netAmount), note]
      );
    }

    res.json({
      code: 200,
      message: netAmount > 0
        ? `Checkout settlement completed — Invoice ${invoiceCode} created for $${Math.ceil(netAmount)}`
        : 'Checkout settlement completed — no amount due (credit covers usage)',
      data: {
        start_reading: startReading,
        checkout_reading: Number(checkout_reading),
        kw_used: kwUsed,
        rate: Number(manual_rate),
        gross_amount: grossAmount,
        prorated_credit: proratedCredit,
        period_days: periodDays,
        net_amount: netAmount,
        tenant_id,
        leasing_id,
        meter_id,
        next_lease_updated: !!nextLease,
        invoice_id: invoiceId ? invoiceId.toString() : null,
        invoice_code: invoiceCode,
      }
    });
  } catch (error) {
    console.error('Checkout settlement error:', error);
    res.status(500).json({ code: 500, message: 'Failed to process checkout settlement' });
  }
});

function daysBetween(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const diff = Math.abs(e - s);
  return Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1; // inclusive
}

// ─── TENANT UTILITY HISTORY ──────────────────────────────────

// GET /api/utility/tenant/:tenantId/history — get all meter readings + bill lines for a tenant
router.get('/tenant/:tenantId/history', authenticate, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const orgId = req.user.orgId;

    // Get all bill lines for this tenant with bill details
    const [billLines] = await req.pool.execute(
      `SELECT bl.*, b.period_start, b.period_end, b.total_amount, b.total_kw, b.rate_per_kw, b.status AS bill_status,
              m.meter_number, m.meter_type,
              u.name AS unit_name,
              p.display_name AS property_name,
              i.invoice_code, i.status AS invoice_status, i.amount AS invoice_amount
       FROM utility_bill_line bl
       JOIN utility_bill b ON bl.bill_id = b.id
       LEFT JOIN utility_meter m ON bl.meter_id = m.id
       LEFT JOIN unit u ON bl.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN invoice i ON bl.invoice_id = i.id
       WHERE bl.tenant_id = ? AND b.org_id = ?
       ORDER BY b.period_start DESC`,
      [tenantId, orgId]
    );

    // Get all meter readings for this tenant
    const [readings] = await req.pool.execute(
      `SELECT mr.*, m.meter_number, m.meter_type,
              u.name AS unit_name, p.display_name AS property_name
       FROM utility_meter_reading mr
       JOIN utility_meter m ON mr.meter_id = m.id
       LEFT JOIN unit u ON m.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE mr.tenant_id = ? AND m.org_id = ?
       ORDER BY mr.reading_date DESC, mr.created_at DESC`,
      [tenantId, orgId]
    );

    // Get checkout settlements for this tenant (table may not exist yet)
    let settlements = [];
    try {
      const [rows] = await req.pool.execute(
        `SELECT cs.*, m.meter_number,
                u.name AS unit_name, p.display_name AS property_name,
                i.invoice_code, i.status AS invoice_status, i.amount AS invoice_amount
         FROM utility_checkout_settlement cs
         LEFT JOIN utility_meter m ON cs.meter_id = m.id
         LEFT JOIN unit u ON m.unit_id = u.id
         LEFT JOIN property p ON u.property_id = p.id
         LEFT JOIN invoice i ON cs.invoice_id = i.id
         WHERE cs.tenant_id = ? AND cs.org_id = ?
         ORDER BY cs.created_at DESC`,
        [tenantId, orgId]
      );
      settlements = rows;
    } catch (e) {
      // Table may not exist yet — return empty
    }

    // Get lease check-in/check-out meter values
    const [leases] = await req.pool.execute(
      `SELECT l.id, l.start_date, l.end_date, l.utility_credit, l.check_in_meter, l.check_out_meter,
              u.name AS unit_name, p.display_name AS property_name
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE l.tenant_id = ? AND p.org_id = ? AND l.deleted_at IS NULL
       ORDER BY l.start_date DESC`,
      [tenantId, orgId]
    );

    res.json({ code: 200, data: { billLines, readings, settlements, leases } });
  } catch (error) {
    console.error('Get tenant utility history error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load utility history' });
  }
});

module.exports = router;

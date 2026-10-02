const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const { generateInvoiceCode } = require('../utils/sequenceCode');
const { orgToday, orgTodaySql } = require('../utils/orgTime');
const { logActivity } = require('../utils/activityLog');
const {
  READING_TYPE_CORRECTION, normaliseReadingDate, parseReadingValue, isCorrection, decideCorrection,
} = require('../utils/meterReading');

const genId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// Format a billing period for an invoice note as "May 9 - July 7, 2026" (year
// shown once when both dates share it). Accepts a Date or a 'YYYY-MM-DD…' string.
// For a Date it reads WALL-CLOCK parts (local getters) — mysql2 returns a DATE
// column as a local-midnight Date, so this preserves the stored day on any server
// TZ (same convention as dateToWallClock elsewhere). Avoids the raw Date.toString()
// ("Sat May 09 2026 00:00:00 GMT+0000 (Coordinated Universal Time)") that
// template-literal interpolation produced before.
const PERIOD_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function fmtPeriod(start, end) {
  const parse = (v) => {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return { y: v.getFullYear(), m: v.getMonth(), d: v.getDate() };
    const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    return { y, m: m - 1, d };
  };
  const a = parse(start), b = parse(end);
  if (!a || !b) return `${start ?? ''} to ${end ?? ''}`.trim(); // fallback: raw
  const md = (x) => `${PERIOD_MONTHS[x.m]} ${x.d}`;
  return a.y === b.y ? `${md(a)} - ${md(b)}, ${b.y}` : `${md(a)}, ${a.y} - ${md(b)}, ${b.y}`;
}

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
    const today = orgToday();

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
router.delete('/group/:id', authenticate, requirePermission('LANDLORD/UTILITY_GROUP_DELETE'), async (req, res) => {
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
    const today = orgToday();

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
                        ROW_NUMBER() OVER (PARTITION BY meter_id ORDER BY reading_date DESC, created_at DESC, id DESC) AS rn
                 FROM utility_meter_reading WHERE org_id = ?
               ) lr ON lr.meter_id = m.id AND lr.rn = 1
               LEFT JOIN (
                 SELECT unit_id, tenant_id, id, end_date, start_date, deleted_at,
                        ROW_NUMBER() OVER (PARTITION BY unit_id ORDER BY start_date DESC) AS rn
                 FROM leasing WHERE deleted_at IS NULL
               ) l ON l.unit_id = m.unit_id AND m.unit_id IS NOT NULL AND l.rn = 1
               LEFT JOIN tenant t ON l.tenant_id = t.id
               WHERE m.org_id = ? AND m.status = 1`;
    const params = [today, today, orgId, orgId];

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
         VALUES (?, ?, ?, ?, ${orgTodaySql()}, 2, 'Initial meter reading')`,
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
//
// A reading correction is NOT a settings change. The Edit Meter form has always
// shown a reading field, and this endpoint used to destructure everything except
// current_reading — so the value was discarded, the request returned 200 and the
// UI said "Meter updated". You could correct a reading, be told it worked, and
// change nothing.
//
// It is accepted now, and it writes a dated CORRECTION entry into the reading log
// rather than only moving the column. Bills are built from that log, so a reading
// that silently contradicted it would be a number with no evidence behind it, and
// a wrong correction could never be seen or undone.
router.put('/meter/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const { group_id, unit_id, meter_number, meter_type, meter_category, current_reading } = req.body;
  const orgId = req.user.orgId;

  // Reject a bad value before it reaches a DECIMAL(12,2). 'abc' used to become
  // NaN, compare unequal to everything, and go to the database as a correction.
  const submitted = parseReadingValue(current_reading);
  if (current_reading !== undefined && current_reading !== null && current_reading !== '' && submitted === null) {
    return res.status(400).json({ code: 400, message: 'Meter reading must be a number of zero or more' });
  }

  let conn;
  try {
    conn = await req.pool.getConnection();
    await conn.beginTransaction();

    // FOR UPDATE: the reading we compare against and the column we then write must
    // not move underneath us. Without it a second correction landing mid-request
    // could leave the log saying one thing and current_reading another — which is
    // the exact inconsistency this endpoint exists to end.
    const [[meter]] = await conn.execute(
      'SELECT id, current_reading FROM utility_meter WHERE id = ? AND org_id = ? FOR UPDATE', [id, orgId]
    );
    if (!meter) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: 'Meter not found' });
    }

    const fields = [];
    const params = [];
    if (group_id !== undefined) { fields.push('group_id = ?'); params.push(group_id); }
    if (unit_id !== undefined) { fields.push('unit_id = ?'); params.push(unit_id || null); }
    if (meter_number !== undefined) { fields.push('meter_number = ?'); params.push(meter_number); }
    if (meter_type !== undefined) { fields.push('meter_type = ?'); params.push(meter_type); }
    if (meter_category !== undefined) { fields.push('meter_category = ?'); params.push(meter_category); }

    // Compare against what the form SHOWED, which is the latest reading by date,
    // not the meter column. Those two can disagree, and comparing against the
    // column would log a correction nobody asked for every time an unrelated field
    // was edited on one of the meters where they differ.
    const [[lastReading]] = await conn.execute(
      `SELECT reading_value, reading_date FROM utility_meter_reading
        WHERE meter_id = ? AND org_id = ?
        ORDER BY reading_date DESC, created_at DESC, id DESC LIMIT 1`,
      [id, orgId]
    );
    const today = orgToday();
    const shown = lastReading ? Number(lastReading.reading_value) : Number(meter.current_reading);
    const wantsCorrection = isCorrection(shown, submitted);
    let duplicateExists = false;
    if (wantsCorrection) {
      const [[duplicate]] = await conn.execute(
        `SELECT id FROM utility_meter_reading
          WHERE meter_id = ? AND org_id = ? AND reading_value = ?
            AND reading_date = ? AND reading_type = ? LIMIT 1`,
        [id, orgId, submitted, today, READING_TYPE_CORRECTION]
      );
      duplicateExists = !!duplicate;
    }
    const decision = decideCorrection({
      latestReading: lastReading || { reading_value: meter.current_reading, reading_date: null },
      submitted, today, duplicateExists,
    });
    const shouldInsertCorrection = decision.action === 'insert';

    if (decision.action === 'blocked-future') {
      await conn.rollback();
      return res.status(409).json({
        code: 409,
        message: `A later reading dated ${decision.date} with value ${decision.value} is hiding this correction. Delete it from Reading History first.`,
      });
    }

    if (fields.length === 0 && !wantsCorrection) {
      await conn.rollback();
      return res.status(400).json({ code: 400, message: 'Nothing to update' });
    }

    if (fields.length > 0) {
      params.push(id, orgId);
      await conn.execute(`UPDATE utility_meter SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`, params);
    }

    let correction = null;
    if (shouldInsertCorrection) {
      const readingId = genId();
      await conn.execute(
        `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [readingId, orgId, id, submitted, today, READING_TYPE_CORRECTION,
         `Corrected from ${shown} to ${submitted} by ${req.user.username || 'a staff user'}`]
      );
      // Dated today, so it is the newest by date and does move the meter — the same
      // rule the reading endpoint applies.
      await conn.execute(
        'UPDATE utility_meter SET current_reading = ? WHERE id = ? AND org_id = ?', [submitted, id, orgId]
      );
      correction = { reading_id: String(readingId), from: shown, to: submitted, date: today };
    }

    await conn.commit();

    // After the commit. A failed audit row must not roll back a correction that
    // succeeded, and logActivity never throws anyway.
    if (correction) {
      await logActivity(req, 'UPDATE', 'utility_meter', id,
        `Corrected meter reading from ${shown} to ${submitted}`);
    }

    res.json({
      code: 200,
      message: correction ? 'Meter updated and reading corrected'
        : decision.action === 'duplicate' ? 'That correction is already in Reading History' : 'Meter updated',
      data: { correction },
    });
  } catch (error) {
    if (conn) { try { await conn.rollback(); } catch { /* the commit already failed */ } }
    console.error('Update utility meter error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update meter' });
  } finally {
    if (conn) conn.release();
  }
});

// DELETE /api/utility/meter/:id
router.delete('/meter/:id', authenticate, requirePermission('LANDLORD/UTILITY_METER_DELETE'), async (req, res) => {
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
      `SELECT reading_value FROM utility_meter_reading WHERE meter_id = ? AND org_id = ? ORDER BY reading_date DESC, created_at DESC, id DESC LIMIT 1`,
      [meter_id, orgId]
    );

    const warning = lastReading && Number(reading_value) < Number(lastReading.reading_value)
      ? `Warning: new reading (${reading_value}) is less than last reading (${lastReading.reading_value})`
      : null;

    // One normalised date for both the row and the newest-by-date comparison.
    // reading_date is a DATE column; a full ISO timestamp would be rejected in
    // strict mode, and its UTC day can differ from the org's day.
    const readingDate = normaliseReadingDate(reading_date, orgToday());
    if (readingDate === null) {
      return res.status(400).json({ code: 400, message: 'Reading date must be a valid date (YYYY-MM-DD)' });
    }
    if (readingDate > orgToday()) {
      return res.status(400).json({ code: 400, message: 'Reading date cannot be in the future' });
    }

    const id = genId();
    await req.pool.execute(
      `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, tenant_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, orgId, meter_id, reading_value, readingDate, reading_type ?? 0, tenant_id || null, notes || null]
    );

    // Also update current_reading on meter for backward compat — but ONLY when this
    // entry is the newest by DATE.
    //
    // This used to run unconditionally, on whatever was typed last. Entering a
    // back-dated reading therefore rewound the meter to a figure from an earlier
    // month while the screen carried on showing the latest one, because the screen
    // reads the log and orders by date. It happened to Mercer 4B on 2 Sep 2026: an
    // August reading of 23,241 was entered at 06:49 and a July reading of 23,134 at
    // 07:44, leaving the meter on the July value. 127 readings across the system
    // were entered after a newer-dated one already existed.
    //
    // A back-dated entry is a correction to history. It belongs in the log, and it
    // must not claim to be where the meter stands today.
    // The condition lives INSIDE the UPDATE, not in a separate SELECT. A newer
    // reading landing between a check and a write would otherwise let this older
    // one overwrite the column anyway.
    const [upd] = await req.pool.execute(
      `UPDATE utility_meter m SET m.current_reading = ?
        WHERE m.id = ? AND m.org_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM utility_meter_reading r
             WHERE r.meter_id = m.id AND r.org_id = ? AND r.reading_date > ?
          )`,
      [reading_value, meter_id, orgId, orgId, readingDate]
    );
    // affectedRows counts rows CHANGED, so re-logging the same value reports 0 even
    // though the reading is the newest. Ask the log separately for the flag the UI
    // shows, and let the UPDATE above be the thing that enforces the rule.
    const [[{ newerCount }]] = await req.pool.execute(
      'SELECT COUNT(*) AS newerCount FROM utility_meter_reading WHERE meter_id = ? AND org_id = ? AND reading_date > ?',
      [meter_id, orgId, readingDate]
    );
    // COUNT(*) arrives as a STRING (the pool sets bigNumberStrings), and '0' is truthy.
    const isNewest = Number(newerCount) === 0;
    if (!isNewest && upd.affectedRows > 0) {
      console.error('[utility/reading] guard disagreed with the UPDATE on meter', meter_id);
    }

    // Auto-sync lease meter values when the reading is a Move-In/Move-Out type.
    //
    // Behaviour:
    //  - Move-Out (type 1): update the CURRENT lease's check_out_meter AND the
    //    NEXT (upcoming) lease's check_in_meter — so when one tenant checks out
    //    the next tenant automatically inherits the meter as their starting point.
    //  - Move-In  (type 0): update the current-or-upcoming lease's check_in_meter.
    //
    // Meter must be mapped to a specific unit (master meters can't target leases).
    // Logs to pm2 and returns an { autoSync } block in the response so operators
    // can see from DevTools / logs why a sync did or didn't happen.
    let autoSync = null;
    const readingTypeNum = Number(reading_type ?? 0);
    if (readingTypeNum === 0 || readingTypeNum === 1) {
      const [[meterUnit]] = await req.pool.execute(
        'SELECT unit_id FROM utility_meter WHERE id = ? AND org_id = ?', [meter_id, orgId]
      );
      const unitId = meterUnit?.unit_id;
      // Uses the normalised readingDate from above. This block used to redeclare it
      // from the raw body, so the lease lookup and the stored row could be matching
      // on two different dates.
      const updates = []; // collect { leaseId, column, role } for response/logs

      if (!unitId) {
        autoSync = { synced: false, reason: 'meter is not mapped to a specific unit (master/property meter)' };
      } else {
        // Identify the CURRENT lease — the one the reading applies to.
        // Preferred: the lease that owns the tenant_id attached to the reading
        // (the meter/reading is explicitly tied to a tenant). If no tenant_id,
        // fall back to the lease whose date range contains the reading_date.
        let current = null;
        if (tenant_id) {
          const [[byTenant]] = await req.pool.execute(
            `SELECT id, start_date, end_date FROM leasing
             WHERE unit_id = ? AND tenant_id = ? AND deleted_at IS NULL
             ORDER BY start_date DESC LIMIT 1`,
            [unitId, tenant_id]
          );
          current = byTenant;
        }
        if (!current) {
          const [[byDate]] = await req.pool.execute(
            `SELECT id, start_date, end_date FROM leasing
             WHERE unit_id = ? AND deleted_at IS NULL
               AND start_date <= ?
               AND (end_date IS NULL OR end_date >= ?)
             ORDER BY start_date DESC LIMIT 1`,
            [unitId, readingDate, readingDate]
          );
          current = byDate;
        }

        // Find the NEXT lease — strictly the one that comes chronologically
        // after the current lease on this unit. Unrelated to reading_date.
        let nextLease = null;
        if (current) {
          const [[n]] = await req.pool.execute(
            `SELECT id, start_date, end_date FROM leasing
             WHERE unit_id = ? AND deleted_at IS NULL
               AND start_date > ?
             ORDER BY start_date ASC LIMIT 1`,
            [unitId, current.start_date]
          );
          nextLease = n;
        }

        if (readingTypeNum === 1) {
          // Move-Out: record on current lease + hand off to next lease
          if (current) {
            await req.pool.execute(
              'UPDATE leasing SET check_out_meter = ?, check_out_meter_updated_at = NOW() WHERE id = ?',
              [reading_value, current.id]
            );
            updates.push({ leaseId: String(current.id), column: 'check_out_meter', role: 'current' });
          }
          if (nextLease) {
            await req.pool.execute(
              'UPDATE leasing SET check_in_meter = ?, check_in_meter_updated_at = NOW() WHERE id = ?',
              [reading_value, nextLease.id]
            );
            updates.push({ leaseId: String(nextLease.id), column: 'check_in_meter', role: 'next' });
          }
        } else {
          // Move-In: write to the current lease (the tenant who's moving in)
          if (current) {
            await req.pool.execute(
              'UPDATE leasing SET check_in_meter = ?, check_in_meter_updated_at = NOW() WHERE id = ?',
              [reading_value, current.id]
            );
            updates.push({ leaseId: String(current.id), column: 'check_in_meter', role: 'current' });
          }
        }

        if (updates.length) {
          autoSync = { synced: true, updates };
          for (const u of updates) {
            console.log(`[utility/reading] Auto-sync ${u.column}=${reading_value} on ${u.role} lease ${u.leaseId}`);
          }
        } else {
          autoSync = { synced: false, reason: 'no current or upcoming lease found for this unit' };
          console.log(`[utility/reading] Auto-sync skipped: no lease for unit ${unitId} at ${readingDate}`);
        }
      }
    }

    res.json({
      code: 200, message: 'Reading logged',
      // meter_advanced tells the caller whether this became the meter's current
      // value or was filed as history behind a newer reading.
      data: { id, warning, autoSync, meter_advanced: isNewest },
    });
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
       ORDER BY r.reading_date DESC, r.created_at DESC, r.id DESC`,
      [meter_id, orgId]
    );

    // Also get check-in meter readings from leases for this meter's unit
    const [[meter]] = await req.pool.execute(
      'SELECT unit_id FROM utility_meter WHERE id = ? AND org_id = ?', [meter_id, orgId]
    );
    let checkInRows = [];
    if (meter?.unit_id) {
      const [leases] = await req.pool.execute(
        `SELECT l.id, l.start_date, l.check_in_meter, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
         FROM leasing l
         LEFT JOIN tenant t ON l.tenant_id = t.id
         WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.check_in_meter IS NOT NULL
         ORDER BY l.start_date DESC`,
        [meter.unit_id]
      );
      checkInRows = leases.map(l => ({
        id: `checkin-${l.id}`,
        reading_value: l.check_in_meter,
        reading_date: l.start_date,
        reading_type: 0, // Move-In
        notes: 'Lease check-in meter',
        tenant_first_name: l.tenant_first_name,
        tenant_last_name: l.tenant_last_name,
        is_lease_checkin: true,
      }));
    }

    // Merge and sort by date descending
    const combined = [...rows, ...checkInRows].sort((a, b) => {
      const dateA = new Date(a.reading_date);
      const dateB = new Date(b.reading_date);
      if (dateB - dateA !== 0) return dateB - dateA;
      // If same date, lease check-ins come after actual readings
      if (a.is_lease_checkin && !b.is_lease_checkin) return 1;
      if (!a.is_lease_checkin && b.is_lease_checkin) return -1;
      return 0;
    });

    res.json({ code: 200, data: combined });
  } catch (error) {
    console.error('Get meter readings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get readings' });
  }
});

// DELETE /api/utility/meter-reading/:id — remove a bad history row and restore
// the denormalised meter value from the next newest row.
router.delete('/meter-reading/:id', authenticate, requirePermission('LANDLORD/UTILITY_METER_DELETE'), async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.orgId;
  let conn;
  let deleted;
  try {
    conn = await req.pool.getConnection();
    await conn.beginTransaction();
    const [[reading]] = await conn.execute(
      `SELECT id, meter_id, reading_value, reading_date, bill_id
         FROM utility_meter_reading WHERE id = ? AND org_id = ? FOR UPDATE`,
      [id, orgId]
    );
    if (!reading) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: 'Meter reading not found' });
    }

    if (reading.bill_id) {
      const [[{ cnt }]] = await conn.execute(
        `SELECT COUNT(*) AS cnt
           FROM utility_bill b
           JOIN utility_bill_line bl ON bl.bill_id = b.id
           JOIN invoice i ON i.id = bl.invoice_id AND i.deleted_at IS NULL
          WHERE b.id = ? AND b.org_id = ?`,
        [reading.bill_id, orgId]
      );
      if (Number(cnt) > 0) {
        await conn.rollback();
        return res.status(400).json({
          code: 400,
          message: 'Cannot delete this reading while its bill has an active invoice. Delete the invoice and bill first.',
        });
      }
    }

    await conn.execute('DELETE FROM utility_meter_reading WHERE id = ? AND org_id = ?', [id, orgId]);
    const [[latest]] = await conn.execute(
      `SELECT reading_value FROM utility_meter_reading
        WHERE meter_id = ? AND org_id = ?
        ORDER BY reading_date DESC, created_at DESC, id DESC LIMIT 1`,
      [reading.meter_id, orgId]
    );
    if (latest) {
      await conn.execute(
        'UPDATE utility_meter SET current_reading = ? WHERE id = ? AND org_id = ?',
        [latest.reading_value, reading.meter_id, orgId]
      );
    }
    await conn.commit();
    deleted = reading;
  } catch (error) {
    if (conn) { try { await conn.rollback(); } catch { /* ignore rollback failure */ } }
    console.error('Delete meter reading error:', error);
    return res.status(500).json({ code: 500, message: 'Failed to delete meter reading' });
  } finally {
    if (conn) conn.release();
  }

  const deletedDate = normaliseReadingDate(deleted.reading_date, orgToday());
  await logActivity(req, 'DELETE', 'utility_meter_reading', id,
    `Deleted meter reading ${deleted.reading_value} dated ${deletedDate}`);
  return res.json({ code: 200, message: 'Reading deleted' });
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
              i.invoice_code, i.status AS invoice_status,
              bp.name AS booking_platform
       FROM utility_bill_line bl
       LEFT JOIN utility_meter m ON bl.meter_id = m.id
       LEFT JOIN unit u ON bl.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON bl.tenant_id = t.id
       LEFT JOIN invoice i ON bl.invoice_id = i.id
       LEFT JOIN leasing l ON bl.leasing_id = l.id
       LEFT JOIN booking_platform bp ON l.booking_platform_id = bp.id
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

      let tenantId = null;
      let leasingId = null;
      let leaseStart = null;
      let leaseEnd = null;
      let utilityCredit = 0;
      let leaseCheckInMeter = null;

      // Find tenant with an active lease at the END of the billing period.
      // If a tenant checked out mid-period, they would have been settled via
      // checkout settlement already — so only include tenants still active at period_end.
      if (!isCommon && meter.unit_id) {
        const [[lease]] = await req.pool.execute(
          `SELECT l.id, l.tenant_id, l.start_date, l.end_date, l.utility_credit, l.check_in_meter
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
          leaseCheckInMeter = lease.check_in_meter != null ? Number(lease.check_in_meter) : null;
        }
      }

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
      // Use the highest value among: last reading log, last finalized bill ending,
      // meter current_reading, or — when a new tenant moved into this unit during
      // the billing period — that tenant's check_in_meter. The check_in_meter
      // represents what the meter read on the new tenant's move-in date, so any
      // consumption between the previous tenant's checkout reading and that value
      // belongs to the vacancy gap (landlord), not the new tenant.
      const candidates = [
        lastReading ? Number(lastReading.reading_value) : 0,
        lastBillLine ? Number(lastBillLine.ending_reading) : 0,
        Number(meter.current_reading) || 0,
        leaseCheckInMeter != null ? leaseCheckInMeter : 0,
      ];
      const startReading = Math.max(...candidates);

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
    const periodEnd = normaliseReadingDate(bill.period_end, orgToday());
    if (periodEnd && periodEnd > orgToday()) {
      return res.status(400).json({
        code: 400,
        message: `This bill's period ends on ${periodEnd}; finalize it on or after that date`,
      });
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
        'UPDATE utility_meter SET current_reading = ? WHERE id = ? AND org_id = ?',
        [line.ending_reading, line.meter_id, orgId]
      );
    }

    await req.pool.execute('UPDATE utility_bill SET status = 1 WHERE id = ? AND org_id = ?', [id, orgId]);
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
        ` | Period: ${fmtPeriod(bill.period_start, bill.period_end)}`;

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
router.delete('/bill/:id', authenticate, requirePermission('LANDLORD/UTILITY_BILL_DELETE'), async (req, res) => {
  let conn;
  let removedReadings = 0;
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    conn = await req.pool.getConnection();
    await conn.beginTransaction();
    const [[bill]] = await conn.execute(
      'SELECT status FROM utility_bill WHERE id = ? AND org_id = ? FOR UPDATE', [id, orgId]
    );
    if (!bill) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: 'Bill not found' });
    }

    // Check if any invoices were generated (exclude soft-deleted invoices)
    const [[{ cnt }]] = await conn.execute(
      `SELECT COUNT(*) as cnt FROM utility_bill_line bl
       JOIN utility_bill b ON b.id = bl.bill_id AND b.org_id = ?
       JOIN invoice i ON i.id = bl.invoice_id
       WHERE bl.bill_id = ? AND bl.invoice_id IS NOT NULL AND i.deleted_at IS NULL`,
      [orgId, id]
    );
    if (Number(cnt) > 0) {
      await conn.rollback();
      return res.status(400).json({
        code: 400,
        message: `Cannot delete: ${cnt} active invoice(s) have been generated from this bill. Delete them first.`
      });
    }
    const [meterRows] = await conn.execute(
      `SELECT DISTINCT bl.meter_id FROM utility_bill_line bl
       JOIN utility_bill b ON b.id = bl.bill_id AND b.org_id = ?
       WHERE bl.bill_id = ? AND bl.meter_id IS NOT NULL`,
      [orgId, id]
    );
    const [deletedResult] = await conn.execute(
      'DELETE FROM utility_meter_reading WHERE bill_id = ? AND org_id = ?', [id, orgId]
    );
    removedReadings = Number(deletedResult.affectedRows || 0);
    await conn.execute('DELETE FROM utility_bill_line WHERE bill_id = ?', [id]);
    await conn.execute('DELETE FROM utility_bill WHERE id = ? AND org_id = ?', [id, orgId]);

    for (const { meter_id } of meterRows) {
      const [[latest]] = await conn.execute(
        `SELECT reading_value FROM utility_meter_reading
          WHERE meter_id = ? AND org_id = ?
          ORDER BY reading_date DESC, created_at DESC, id DESC LIMIT 1`,
        [meter_id, orgId]
      );
      if (latest) {
        await conn.execute(
          'UPDATE utility_meter SET current_reading = ? WHERE id = ? AND org_id = ?',
          [latest.reading_value, meter_id, orgId]
        );
      }
    }
    await conn.commit();
    await logActivity(req, 'DELETE', 'utility_bill', id,
      `Deleted utility bill and removed ${removedReadings} meter reading(s)`);
    res.json({ code: 200, message: `Bill deleted; ${removedReadings} reading(s) removed` });
  } catch (error) {
    if (conn) { try { await conn.rollback(); } catch { /* ignore rollback failure */ } }
    console.error('Delete utility bill error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete bill' });
  } finally {
    if (conn) conn.release();
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

      // Get all bill lines for these bills.
      // ORDER BY b.period_end DESC, u.name — so for each meter, the FIRST line
      // we see in the loop below is from the most recent bill. That's the line
      // whose tenant_id reflects the currently-active tenant. Without this
      // ordering, an older bill's tenant (e.g. Sudharshan, who has since
      // checked out) would shadow the newer tenant (e.g. Kuang Yu Heng) in the
      // report header even though the latest bill_line is already correct.
      const billIds = bills.map(b => b.id);
      const placeholders = billIds.map(() => '?').join(',');
      const [lines] = await req.pool.execute(
        `SELECT bl.*, m.meter_number,
                u.name AS unit_name, u.property_id,
                p.display_name AS property_name,
                t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                t.company_name AS tenant_company_name, t.type AS tenant_type,
                i.status AS invoice_status, i.invoice_code,
                b.period_end AS bill_period_end,
                bp.name AS booking_platform
         FROM utility_bill_line bl
         JOIN utility_bill b ON bl.bill_id = b.id
         LEFT JOIN utility_meter m ON bl.meter_id = m.id
         LEFT JOIN unit u ON bl.unit_id = u.id
         LEFT JOIN property p ON u.property_id = p.id
         LEFT JOIN tenant t ON bl.tenant_id = t.id
         LEFT JOIN invoice i ON bl.invoice_id = i.id
         LEFT JOIN leasing l ON bl.leasing_id = l.id
         LEFT JOIN booking_platform bp ON l.booking_platform_id = bp.id
         WHERE bl.bill_id IN (${placeholders})
         ORDER BY b.period_end DESC, u.name`,
        billIds
      );

      // Group lines by unit (meter)
      const unitMap = {};
      for (const line of lines) {
        if (Number(line.is_common_area)) continue;
        const key = line.meter_id?.toString() || line.id.toString();
        if (!unitMap[key]) {
          // Because lines are sorted by bill.period_end DESC, the first
          // occurrence per meter is the most recent bill — and its tenant_id
          // is the currently-active tenant. (Older bills under the same meter
          // may still point at the prior tenant, which is historically correct
          // but should NOT drive the column header.)
          const tenantName = Number(line.tenant_type) === 1 && line.tenant_company_name
            ? line.tenant_company_name
            : [line.tenant_first_name, line.tenant_last_name].filter(Boolean).join(' ');
          unitMap[key] = {
            meter_id: line.meter_id,
            meter_number: line.meter_number,
            unit_name: line.unit_name,
            property_name: line.property_name,
            tenant_name: tenantName || null,
            // Same most-recent-line rule as tenant_name above: the platform shown
            // is the one on the lease that the displayed tenant is actually under,
            // not whoever occupied the meter six bills ago.
            booking_platform: line.booking_platform || null,
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

    let sql = `SELECT MAX(rate_per_kw) AS highest_rate FROM utility_bill WHERE org_id = ? AND period_start >= DATE_SUB(${orgTodaySql()}, INTERVAL 1 YEAR)`;
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
       LEFT JOIN utility_checkout_settlement ucs ON ucs.leasing_id = l.id AND ucs.meter_id = m.id
       WHERE m.org_id = ? AND m.status = 1 AND m.meter_category = 1
         AND ucs.id IS NULL
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
      reading_date, last_reading_override
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

    // Get last reading — check meter reading log, last finalized bill ending, and meter current_reading
    const [[lastReading]] = await req.pool.execute(
      `SELECT reading_value, reading_date FROM utility_meter_reading
       WHERE meter_id = ? ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
      [meter_id]
    );
    const [[lastBillLine]] = await req.pool.execute(
      `SELECT bl.ending_reading, b.period_end FROM utility_bill_line bl
       JOIN utility_bill b ON bl.bill_id = b.id
       WHERE bl.meter_id = ? AND b.status = 1
       ORDER BY b.period_end DESC LIMIT 1`,
      [meter_id]
    );
    const candidates = [
      lastReading ? Number(lastReading.reading_value) : 0,
      lastBillLine ? Number(lastBillLine.ending_reading) : 0,
      Number(meter.current_reading) || 0
    ];
    // Allow manual override of the last reading if provided
    const startReading = last_reading_override != null ? Number(last_reading_override) : Math.max(...candidates);
    // Credit period starts the day AFTER the last finalized bill ended (each day
    // belongs to exactly one billing period). If no prior bill, or if the lease
    // started later than that, use lease.start_date.
    let startDate;
    if (lastBillLine) {
      const dayAfterLastBill = new Date(lastBillLine.period_end);
      dayAfterLastBill.setDate(dayAfterLastBill.getDate() + 1);
      const leaseStart = new Date(lease.start_date);
      startDate = dayAfterLastBill > leaseStart ? dayAfterLastBill : lease.start_date;
    } else {
      startDate = lease.start_date;
    }

    // Calculate usage
    const kwUsed = Number(checkout_reading) - startReading;
    if (kwUsed < 0) {
      return res.status(400).json({ code: 400, message: 'Checkout reading cannot be less than the last reading' });
    }

    const grossAmount = kwUsed * Number(manual_rate);

    // Prorate credit: (monthly_credit * 12 / 365) * days
    const utilityCredit = Number(lease.utility_credit) || 0;
    const settlementDate = reading_date || orgToday();
    const periodDays = daysBetween(startDate, settlementDate);
    const proratedCredit = utilityCredit > 0 ? Math.round((utilityCredit * 12 / 365) * periodDays * 100) / 100 : 0;
    const netAmount = Math.max(0, Math.round((grossAmount - proratedCredit) * 100) / 100);

    // 1. Find the next tenant's lease — defined as the chronologically next lease
    //    on the same unit relative to the LEASE BEING CHECKED OUT, not the
    //    settlement date. This way late settlements (e.g. settling Tenant A on
    //    Apr 5 when Tenant B already moved in Apr 1) still hand off correctly.
    //    Mirrors the move-out reading flow at line ~462.
    const [[nextLease]] = await req.pool.execute(
      `SELECT id FROM leasing WHERE unit_id = ? AND deleted_at IS NULL AND id != ? AND start_date > ?
       ORDER BY start_date ASC LIMIT 1`,
      [lease.unit_id, leasing_id, lease.start_date]
    );

    // 2. Create settlement record FIRST to prevent orphan data if something fails
    const readingId = genId();
    const settlementId = genId();
    await req.pool.execute(
      `INSERT INTO utility_checkout_settlement
       (id, org_id, meter_id, tenant_id, leasing_id,
        starting_reading, checkout_reading, kw_used, rate_per_kw,
        gross_amount, utility_credit, prorated_credit, period_days, net_amount,
        reading_date, reading_id, invoice_id, next_lease_id, previous_meter_reading)
       VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)`,
      [settlementId, orgId, meter_id, tenant_id, leasing_id,
       startReading, checkout_reading, kwUsed, manual_rate,
       grossAmount, utilityCredit, proratedCredit, periodDays, netAmount,
       settlementDate, readingId, null, nextLease?.id || null, Number(meter.current_reading)]
    );

    // 3. Log the checkout meter reading
    await req.pool.execute(
      `INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, tenant_id, notes)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [readingId, orgId, meter_id, checkout_reading, settlementDate, tenant_id, 'Checkout settlement']
    );

    // 4. Update meter current_reading
    await req.pool.execute('UPDATE utility_meter SET current_reading = ? WHERE id = ?', [checkout_reading, meter_id]);

    // 5. Update current lease check_out_meter
    await req.pool.execute(
      'UPDATE leasing SET check_out_meter = ?, check_out_meter_updated_at = NOW() WHERE id = ?',
      [checkout_reading, leasing_id]
    );

    // 6. Update next tenant's check_in_meter if applicable
    if (nextLease) {
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

      // Update the settlement record with the invoice_id
      await req.pool.execute(
        'UPDATE utility_checkout_settlement SET invoice_id = ? WHERE id = ?',
        [invoiceId, settlementId]
      );
    }

    res.json({
      code: 200,
      message: netAmount > 0
        ? `Checkout settlement completed — Invoice ${invoiceCode} created for $${Math.ceil(netAmount)}`
        : 'Checkout settlement completed — no amount due (credit covers usage)',
      data: {
        settlement_id: settlementId.toString(),
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

// PUT /api/utility/checkout-settlement/:id — edit a checkout settlement
router.put('/checkout-settlement/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { checkout_reading, rate_per_kw } = req.body;
    const orgId = req.user.orgId;

    const [[settlement]] = await req.pool.execute(
      'SELECT * FROM utility_checkout_settlement WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!settlement) return res.status(404).json({ code: 404, message: 'Settlement not found' });

    const newReading = checkout_reading != null ? Number(checkout_reading) : Number(settlement.checkout_reading);
    const newRate = rate_per_kw != null ? Number(rate_per_kw) : Number(settlement.rate_per_kw);
    const startReading = Number(settlement.starting_reading);

    const kwUsed = newReading - startReading;
    if (kwUsed < 0) {
      return res.status(400).json({ code: 400, message: 'Checkout reading cannot be less than starting reading' });
    }

    const grossAmount = kwUsed * newRate;
    const utilityCredit = Number(settlement.utility_credit);
    const periodDays = settlement.period_days;
    const proratedCredit = utilityCredit > 0 ? Math.round((utilityCredit * 12 / 365) * periodDays * 100) / 100 : 0;
    const netAmount = Math.max(0, Math.round((grossAmount - proratedCredit) * 100) / 100);

    // Update settlement record
    await req.pool.execute(
      `UPDATE utility_checkout_settlement
       SET checkout_reading = ?, kw_used = ?, rate_per_kw = ?,
           gross_amount = ?, prorated_credit = ?, net_amount = ?
       WHERE id = ?`,
      [newReading, kwUsed, newRate, grossAmount, proratedCredit, netAmount, id]
    );

    // Update the linked meter reading
    if (settlement.reading_id) {
      await req.pool.execute(
        'UPDATE utility_meter_reading SET reading_value = ? WHERE id = ?',
        [newReading, settlement.reading_id]
      );
    }

    // Update meter current_reading
    await req.pool.execute(
      'UPDATE utility_meter SET current_reading = ? WHERE id = ?',
      [newReading, settlement.meter_id]
    );

    // Update lease check_out_meter
    await req.pool.execute(
      'UPDATE leasing SET check_out_meter = ?, check_out_meter_updated_at = NOW() WHERE id = ?',
      [newReading, settlement.leasing_id]
    );

    // Update next lease check_in_meter if applicable
    if (settlement.next_lease_id) {
      await req.pool.execute(
        'UPDATE leasing SET check_in_meter = ?, check_in_meter_updated_at = NOW() WHERE id = ?',
        [newReading, settlement.next_lease_id]
      );
    }

    // Update invoice amount if exists
    if (settlement.invoice_id) {
      if (netAmount > 0) {
        // Get meter number for note
        const [[meterInfo]] = await req.pool.execute('SELECT meter_number FROM utility_meter WHERE id = ?', [settlement.meter_id]);
        const meterNumber = meterInfo?.meter_number || 'N/A';
        const note = `Utility checkout settlement: ${kwUsed} kW × $${newRate.toFixed(4)}/kW = $${grossAmount.toFixed(2)}` +
          (proratedCredit > 0 ? ` | Credit: -$${proratedCredit.toFixed(2)}` : '') +
          ` | Meter: ${meterNumber}` +
          ` | Reading: ${startReading} → ${newReading}`;
        await req.pool.execute(
          'UPDATE invoice SET amount = ?, note = ? WHERE id = ? AND deleted_at IS NULL',
          [Math.ceil(netAmount), note, settlement.invoice_id]
        );
      } else {
        // Net is now 0 — soft-delete the invoice
        await req.pool.execute(
          'UPDATE invoice SET deleted_at = NOW() WHERE id = ?', [settlement.invoice_id]
        );
        await req.pool.execute(
          'UPDATE utility_checkout_settlement SET invoice_id = NULL WHERE id = ?', [id]
        );
      }
    }

    res.json({
      code: 200,
      message: 'Settlement updated',
      data: {
        checkout_reading: newReading,
        kw_used: kwUsed,
        rate: newRate,
        gross_amount: grossAmount,
        prorated_credit: proratedCredit,
        net_amount: netAmount,
      }
    });
  } catch (error) {
    console.error('Edit checkout settlement error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update settlement' });
  }
});

// DELETE /api/utility/checkout-settlement/:id — undo a checkout settlement
router.delete('/checkout-settlement/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[settlement]] = await req.pool.execute(
      'SELECT * FROM utility_checkout_settlement WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!settlement) return res.status(404).json({ code: 404, message: 'Settlement not found' });

    // Guard: check if any later meter readings exist (from subsequent billing or settlements)
    const [[{ laterCount }]] = await req.pool.execute(
      `SELECT COUNT(*) as laterCount FROM utility_meter_reading
       WHERE meter_id = ? AND id != ? AND reading_date > ?`,
      [settlement.meter_id, settlement.reading_id, settlement.reading_date]
    );
    if (Number(laterCount) > 0) {
      return res.status(400).json({
        code: 400,
        message: 'Cannot undo: there are newer meter readings after this settlement. Undo those first.'
      });
    }

    // 1. Delete the meter reading
    if (settlement.reading_id) {
      await req.pool.execute('DELETE FROM utility_meter_reading WHERE id = ?', [settlement.reading_id]);
    }

    // 2. Revert meter current_reading to previous value
    if (settlement.previous_meter_reading != null) {
      await req.pool.execute(
        'UPDATE utility_meter SET current_reading = ? WHERE id = ?',
        [settlement.previous_meter_reading, settlement.meter_id]
      );
    }

    // 3. Clear lease check_out_meter
    await req.pool.execute(
      'UPDATE leasing SET check_out_meter = NULL, check_out_meter_updated_at = NOW() WHERE id = ?',
      [settlement.leasing_id]
    );

    // 4. Clear next lease check_in_meter if it was auto-set
    if (settlement.next_lease_id) {
      await req.pool.execute(
        'UPDATE leasing SET check_in_meter = NULL, check_in_meter_updated_at = NOW() WHERE id = ?',
        [settlement.next_lease_id]
      );
    }

    // 5. Soft-delete the auto-generated invoice
    if (settlement.invoice_id) {
      await req.pool.execute(
        'UPDATE invoice SET deleted_at = NOW() WHERE id = ?', [settlement.invoice_id]
      );
    }

    // 6. Delete the settlement record
    await req.pool.execute('DELETE FROM utility_checkout_settlement WHERE id = ?', [id]);

    res.json({ code: 200, message: 'Settlement undone successfully' });
  } catch (error) {
    console.error('Undo checkout settlement error:', error);
    res.status(500).json({ code: 500, message: 'Failed to undo settlement' });
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

// GET /api/utility/last-meter-reading?unit_id=...&before_date=YYYY-MM-DD
// Most recent meter reading on any unit-mapped meter for this unit, before
// `before_date` (defaults to today). Used by the create-lease form to
// prefill check_in_meter when the previous tenant's checkout reading was
// logged before the new lease existed.
const { findLastMeterReadingForUnit } = require('../utils/meterReadingLookup');
router.get('/last-meter-reading', authenticate, async (req, res) => {
  try {
    const { unit_id, before_date } = req.query;
    if (!unit_id) {
      return res.status(400).json({ code: 400, message: 'unit_id is required' });
    }
    const data = await findLastMeterReadingForUnit(req.pool, unit_id, before_date || null);
    res.json({ code: 200, data });
  } catch (error) {
    console.error('Get last meter reading error:', error);
    res.status(500).json({ code: 500, message: 'Failed to look up last meter reading' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { orgToday } = require('../utils/orgTime');

const genId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// Helper: get Monday of the week containing a given date
function getMonday(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1; // Mon=0
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().split('T')[0];
}

// Helper: add N days to a date string
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// ─── CLEANERS (Settings) ─────────────────────────────────────────────────────

// GET /api/cleaning/cleaners - List all cleaners
router.get('/cleaners', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT id, name, status, created_at FROM cleaner WHERE org_id = ? ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('List cleaners error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list cleaners' });
  }
});

// POST /api/cleaning/cleaner - Create cleaner
router.post('/cleaner', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    const orgId = req.user.orgId;
    if (!name) return res.status(400).json({ code: 400, message: 'Name is required' });

    const id = genId();
    await req.pool.execute(
      'INSERT INTO cleaner (id, org_id, name, status) VALUES (?, ?, ?, 1)',
      [id, orgId, name]
    );
    res.json({ code: 200, message: 'Cleaner created', data: { id } });
  } catch (error) {
    console.error('Create cleaner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create cleaner' });
  }
});

// PUT /api/cleaning/cleaner/:id - Update cleaner
router.put('/cleaner/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status } = req.body;
    const orgId = req.user.orgId;

    await req.pool.execute(
      'UPDATE cleaner SET name = ?, status = ? WHERE id = ? AND org_id = ?',
      [name || '', status ?? 1, id, orgId]
    );
    res.json({ code: 200, message: 'Cleaner updated' });
  } catch (error) {
    console.error('Update cleaner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update cleaner' });
  }
});

// DELETE /api/cleaning/cleaner/:id - Delete cleaner
router.delete('/cleaner/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Check if cleaner is assigned to any configs
    const [[linked]] = await req.pool.execute(
      'SELECT COUNT(*) as cnt FROM unit_cleaning_config WHERE cleaner_id = ? AND org_id = ?',
      [id, orgId]
    );
    if (Number(linked.cnt) > 0) {
      return res.status(400).json({
        code: 400,
        message: `Cannot delete: cleaner is assigned to ${linked.cnt} unit(s). Reassign them first.`
      });
    }

    await req.pool.execute('DELETE FROM cleaner WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Cleaner deleted' });
  } catch (error) {
    console.error('Delete cleaner error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete cleaner' });
  }
});

// ─── UNIT CLEANING CONFIG (Weekly Cleaning tab) ─────────────────────────────

// GET /api/cleaning/config - Get ALL active units with their cleaning config + current tenant
router.get('/config', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const today = orgToday();

    // Get all active units with property info, LEFT JOIN cleaning config, and current tenant via active lease
    const [rows] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.property_id,
              p.display_name AS property_name,
              ucc.id AS config_id, ucc.cleaning_day, ucc.cleaner_id,
              cl.name AS cleaner_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.cleaning_notes AS tenant_cleaning_notes
       FROM unit u
       JOIN property p ON u.property_id = p.id AND p.org_id = ?
       LEFT JOIN unit_cleaning_config ucc ON ucc.unit_id = u.id
       LEFT JOIN cleaner cl ON ucc.cleaner_id = cl.id
       LEFT JOIN leasing l ON l.unit_id = u.id AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL) AND l.deleted_at IS NULL
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE u.active_status = 1
       ORDER BY p.display_name, u.name`,
      [orgId, today, today]
    );

    // Deduplicate in case multiple active leases (take first)
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = r.unit_id.toString();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }

    res.json({ code: 200, data: deduped });
  } catch (error) {
    console.error('List cleaning config error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list cleaning config' });
  }
});

// POST /api/cleaning/config/save - Bulk save unit cleaning configs
// Body: { configs: [{ unit_id, property_id, cleaning_day, cleaner_id }] }
router.post('/config/save', authenticate, async (req, res) => {
  try {
    const { configs } = req.body;
    const orgId = req.user.orgId;
    if (!Array.isArray(configs)) return res.status(400).json({ code: 400, message: 'configs array required' });

    for (const cfg of configs) {
      const { unit_id, property_id, cleaning_day, cleaner_id } = cfg;
      if (!unit_id) continue;

      // Upsert: check if config exists for this unit
      const [[existing]] = await req.pool.execute(
        'SELECT id FROM unit_cleaning_config WHERE unit_id = ? AND org_id = ?',
        [unit_id, orgId]
      );

      if (existing) {
        await req.pool.execute(
          'UPDATE unit_cleaning_config SET cleaning_day = ?, cleaner_id = ?, property_id = ? WHERE id = ? AND org_id = ?',
          [cleaning_day ?? null, cleaner_id || null, property_id, existing.id, orgId]
        );
      } else {
        const id = genId();
        await req.pool.execute(
          'INSERT INTO unit_cleaning_config (id, org_id, property_id, unit_id, cleaning_day, cleaner_id) VALUES (?, ?, ?, ?, ?, ?)',
          [id, orgId, property_id, unit_id, cleaning_day ?? null, cleaner_id || null]
        );
      }
    }

    res.json({ code: 200, message: 'Cleaning config saved' });
  } catch (error) {
    console.error('Save cleaning config error:', error);
    res.status(500).json({ code: 500, message: 'Failed to save cleaning config' });
  }
});

// ─── UNIT CLEANING OVERRIDES ─────────────────────────────────────────────────

// GET /api/cleaning/overrides?week_of=YYYY-MM-DD - Get overrides for a week
router.get('/overrides', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { week_of } = req.query;
    if (!week_of) return res.status(400).json({ code: 400, message: 'week_of required' });

    const [rows] = await req.pool.execute(
      'SELECT id, unit_id, week_of, override_type, override_day, notes FROM unit_cleaning_override WHERE org_id = ? AND week_of = ?',
      [orgId, week_of]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('List overrides error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list overrides' });
  }
});

// POST /api/cleaning/override - Save override for a unit+week
// Body: { unit_id, week_of, override_type, override_day }
router.post('/override', authenticate, async (req, res) => {
  try {
    const { unit_id, week_of, override_type, override_day, notes } = req.body;
    const orgId = req.user.orgId;
    if (!unit_id || !week_of) return res.status(400).json({ code: 400, message: 'unit_id and week_of required' });

    // Delete existing override for this unit+week first
    await req.pool.execute(
      'DELETE FROM unit_cleaning_override WHERE unit_id = ? AND week_of = ? AND org_id = ?',
      [unit_id, week_of, orgId]
    );

    // If override_type is null/undefined, we're clearing the override (back to Normal)
    if (override_type !== null && override_type !== undefined) {
      const id = genId();
      await req.pool.execute(
        'INSERT INTO unit_cleaning_override (id, org_id, unit_id, week_of, override_type, override_day, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, orgId, unit_id, week_of, override_type, override_day ?? null, notes || null]
      );
    }

    res.json({ code: 200, message: 'Override saved' });
  } catch (error) {
    console.error('Save override error:', error);
    res.status(500).json({ code: 500, message: 'Failed to save override' });
  }
});

// ─── WEEK NOTES (per property per week) ──────────────────────────────────────

// GET /api/cleaning/week-notes?week_of=YYYY-MM-DD
router.get('/week-notes', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { week_of } = req.query;
    if (!week_of) return res.status(400).json({ code: 400, message: 'week_of required' });
    const [rows] = await req.pool.execute(
      'SELECT id, property_id, week_of, notes FROM cleaning_week_notes WHERE org_id = ? AND week_of = ?',
      [orgId, week_of]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get week notes error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load week notes' });
  }
});

// POST /api/cleaning/week-notes - Save notes for a property+week
// Body: { property_id, week_of, notes }
router.post('/week-notes', authenticate, async (req, res) => {
  try {
    const { property_id, week_of, notes } = req.body;
    const orgId = req.user.orgId;
    if (!property_id || !week_of) return res.status(400).json({ code: 400, message: 'property_id and week_of required' });

    // Delete existing
    await req.pool.execute(
      'DELETE FROM cleaning_week_notes WHERE property_id = ? AND week_of = ? AND org_id = ?',
      [property_id, week_of, orgId]
    );

    if (notes && notes.trim()) {
      const id = genId();
      await req.pool.execute(
        'INSERT INTO cleaning_week_notes (id, org_id, property_id, week_of, notes) VALUES (?, ?, ?, ?, ?)',
        [id, orgId, property_id, week_of, notes.trim()]
      );
    }

    res.json({ code: 200, message: 'Notes saved' });
  } catch (error) {
    console.error('Save week notes error:', error);
    res.status(500).json({ code: 500, message: 'Failed to save notes' });
  }
});

// ─── CHECKOUT CLEANING ───────────────────────────────────────────────────────

// GET /api/cleaning/checkout - List leases ending in selected month with checkout cleaning info
// Query params: month=YYYY-MM (optional, defaults to current month)
router.get('/checkout', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { month } = req.query;

    // Default to current month
    const now = new Date();
    const targetMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = `${targetMonth}-01`;
    const [year, mon] = targetMonth.split('-').map(Number);
    const monthEnd = `${targetMonth}-${new Date(year, mon, 0).getDate()}`;

    // Pull all leases ending in this month, LEFT JOIN checkout_cleaning + next lease
    const [rows] = await req.pool.execute(
      `SELECT l.id AS lease_id, l.tenant_id, l.unit_id, l.end_date AS lease_end_date,
              u.property_id, p.display_name AS property_name, u.name AS unit_name,
              t.first_name, t.last_name,
              cc.id AS checkout_id, cc.cleaning_date, cc.cleaner_id, cc.status AS checkout_status, cc.notes,
              cl.name AS cleaner_name,
              nl.start_date AS next_lease_start,
              nt.first_name AS next_tenant_first, nt.last_name AS next_tenant_last
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id AND p.org_id = ?
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN checkout_cleaning cc ON cc.lease_id = l.id
       LEFT JOIN cleaner cl ON cc.cleaner_id = cl.id
       LEFT JOIN leasing nl ON nl.unit_id = l.unit_id AND nl.deleted_at IS NULL
         AND nl.start_date = (SELECT MIN(nl2.start_date) FROM leasing nl2 WHERE nl2.unit_id = l.unit_id AND nl2.start_date > l.end_date AND nl2.deleted_at IS NULL)
       LEFT JOIN tenant nt ON nl.tenant_id = nt.id
       WHERE l.end_date >= ? AND l.end_date <= ? AND l.deleted_at IS NULL
       ORDER BY l.end_date ASC`,
      [orgId, monthStart, monthEnd]
    );

    // Auto-create checkout_cleaning rows for leases that don't have one yet
    const toCreate = rows.filter(r => !r.checkout_id);
    for (const r of toCreate) {
      const id = genId();
      await req.pool.execute(
        `INSERT INTO checkout_cleaning (id, org_id, lease_id, tenant_id, property_id, unit_id, cleaning_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [id, orgId, r.lease_id, r.tenant_id, r.property_id, r.unit_id, r.lease_end_date]
      );
      r.checkout_id = id;
      r.cleaning_date = r.lease_end_date;
      r.checkout_status = 0;
    }

    // Normalize output
    const data = rows.map(r => ({
      id: r.checkout_id,
      lease_id: r.lease_id,
      tenant_id: r.tenant_id,
      property_id: r.property_id,
      unit_id: r.unit_id,
      property_name: r.property_name,
      unit_name: r.unit_name,
      first_name: r.first_name,
      last_name: r.last_name,
      lease_end_date: r.lease_end_date,
      cleaning_date: r.cleaning_date || r.lease_end_date,
      cleaner_id: r.cleaner_id,
      cleaner_name: r.cleaner_name,
      status: r.checkout_status ?? 0,
      notes: r.notes,
      next_lease_start: r.next_lease_start || null,
      next_tenant_name: [r.next_tenant_first, r.next_tenant_last].filter(Boolean).join(' ') || null,
    }));

    res.json({ code: 200, data });
  } catch (error) {
    console.error('List checkout cleaning error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list checkout cleaning' });
  }
});

// PUT /api/cleaning/checkout/:id - Update checkout cleaning fields
router.put('/checkout/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const updates = [];
    const params = [];

    if (req.body.cleaning_date !== undefined) {
      updates.push('cleaning_date = ?');
      params.push(req.body.cleaning_date || null);
    }
    if (req.body.cleaner_id !== undefined) {
      updates.push('cleaner_id = ?');
      params.push(req.body.cleaner_id || null);
    }
    if (req.body.notes !== undefined) {
      updates.push('notes = ?');
      params.push(req.body.notes || null);
    }

    if (updates.length === 0) return res.json({ code: 200, message: 'Nothing to update' });

    params.push(id, orgId);
    await req.pool.execute(
      `UPDATE checkout_cleaning SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );
    res.json({ code: 200, message: 'Checkout cleaning updated' });
  } catch (error) {
    console.error('Update checkout cleaning error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update checkout cleaning' });
  }
});

// ─── WEEKLY SCHEDULE (Generated) ─────────────────────────────────────────────

// GET /api/cleaning/schedule?week_of=YYYY-MM-DD - Get generated schedule for a week
router.get('/schedule', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { week_of } = req.query;
    if (!week_of) return res.status(400).json({ code: 400, message: 'week_of required' });

    const [rows] = await req.pool.execute(
      `SELECT cs.id, cs.property_id, cs.unit_id, cs.cleaner_id, cs.scheduled_date,
              cs.type, cs.lease_id, cs.tenant_id, cs.status, cs.notes, cs.cleaning_notes,
              p.display_name AS property_name, u.name AS unit_name,
              cl.name AS cleaner_name,
              t.first_name, t.last_name
       FROM cleaning_schedule cs
       JOIN unit u ON cs.unit_id = u.id
       JOIN property p ON cs.property_id = p.id
       LEFT JOIN cleaner cl ON cs.cleaner_id = cl.id
       LEFT JOIN tenant t ON cs.tenant_id = t.id
       WHERE cs.org_id = ? AND cs.week_of = ?
       ORDER BY cs.scheduled_date, p.display_name, u.name`,
      [orgId, week_of]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get schedule error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get schedule' });
  }
});

// POST /api/cleaning/schedule/generate - Generate schedule for a week
// Body: { week_of: 'YYYY-MM-DD' (must be a Monday) }
router.post('/schedule/generate', authenticate, async (req, res) => {
  try {
    const { week_of } = req.body;
    const orgId = req.user.orgId;
    if (!week_of) return res.status(400).json({ code: 400, message: 'week_of required' });

    // Verify it's a Monday
    const dayOfWeek = new Date(week_of).getUTCDay();
    if (dayOfWeek !== 1) {
      return res.status(400).json({ code: 400, message: 'week_of must be a Monday' });
    }

    // 1. Wipe existing schedule for this week
    await req.pool.execute(
      'DELETE FROM cleaning_schedule WHERE org_id = ? AND week_of = ?',
      [orgId, week_of]
    );

    // 2. Get all unit cleaning configs
    const [configs] = await req.pool.execute(
      'SELECT unit_id, property_id, cleaning_day, cleaner_id FROM unit_cleaning_config WHERE org_id = ? AND cleaning_day IS NOT NULL',
      [orgId]
    );

    // 3. Get overrides for this week
    const [overrides] = await req.pool.execute(
      'SELECT unit_id, override_type, override_day, notes FROM unit_cleaning_override WHERE org_id = ? AND week_of = ?',
      [orgId, week_of]
    );
    const overrideMap = {};
    for (const o of overrides) {
      overrideMap[o.unit_id.toString()] = o;
    }

    // 4. Get active tenant cleaning notes for all units
    const today = orgToday();
    const [tenantNotes] = await req.pool.execute(
      `SELECT l.unit_id, t.cleaning_notes
       FROM leasing l
       JOIN tenant t ON l.tenant_id = t.id
       WHERE l.deleted_at IS NULL AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
         AND t.cleaning_notes IS NOT NULL AND t.cleaning_notes != ''`,
      [today, today]
    );
    const tenantNotesMap = {};
    for (const tn of tenantNotes) {
      tenantNotesMap[tn.unit_id.toString()] = tn.cleaning_notes;
    }

    // 5. Generate weekly tasks
    const inserted = [];
    for (const cfg of configs) {
      const unitKey = cfg.unit_id.toString();
      const override = overrideMap[unitKey];

      let effectiveDay = Number(cfg.cleaning_day);
      if (override) {
        if (Number(override.override_type) === 0) continue; // skip
        if (Number(override.override_type) === 1 && override.override_day !== null) {
          effectiveDay = Number(override.override_day); // move to different day
        }
        // type=2 (notes-only) — keep original day, just carry notes
      }

      // Calculate date: week_of is Monday (day 0), so add effectiveDay
      const scheduledDate = addDays(week_of, effectiveDay);
      const overrideNotes = override?.notes || null;
      const tenantCleaningNotes = tenantNotesMap[unitKey] || null;

      const id = genId();
      await req.pool.execute(
        `INSERT INTO cleaning_schedule (id, org_id, property_id, unit_id, cleaner_id, scheduled_date, type, week_of, notes, cleaning_notes)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [id, orgId, cfg.property_id, cfg.unit_id, cfg.cleaner_id || null, scheduledDate, week_of, overrideNotes, tenantCleaningNotes]
      );
      inserted.push(id);
    }

    // 5. Pull in checkout cleanings that fall within this week (Mon to Sun)
    const weekEnd = addDays(week_of, 6);
    const [checkouts] = await req.pool.execute(
      `SELECT cc.id AS checkout_id, cc.property_id, cc.unit_id, cc.cleaner_id, cc.cleaning_date, cc.lease_id, cc.tenant_id
       FROM checkout_cleaning cc
       WHERE cc.org_id = ? AND cc.status = 0 AND cc.cleaning_date >= ? AND cc.cleaning_date <= ?`,
      [orgId, week_of, weekEnd]
    );

    for (const co of checkouts) {
      const id = genId();
      await req.pool.execute(
        `INSERT INTO cleaning_schedule (id, org_id, property_id, unit_id, cleaner_id, scheduled_date, type, lease_id, tenant_id, week_of)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [id, orgId, co.property_id, co.unit_id, co.cleaner_id || null, co.cleaning_date, co.lease_id, co.tenant_id, week_of]
      );
      inserted.push(id);
    }

    res.json({ code: 200, message: `Schedule generated: ${inserted.length} tasks`, data: { count: inserted.length } });
  } catch (error) {
    console.error('Generate schedule error:', error);
    res.status(500).json({ code: 500, message: 'Failed to generate schedule' });
  }
});

// ─── CHECKOUT NOTES ──────────────────────────────────────────────────────────

// GET /api/cleaning/checkout-notes?week_of=YYYY-MM-DD
router.get('/checkout-notes', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { week_of } = req.query;
    if (!week_of) return res.status(400).json({ code: 400, message: 'week_of required' });

    // Monday to Sunday
    const weekStart = week_of;
    const weekEnd = addDays(week_of, 6);

    // Leases ending in this week + next lease + checkout_notes
    const [rows] = await req.pool.execute(
      `SELECT l.id AS lease_id, l.tenant_id, l.unit_id, l.end_date AS lease_end,
              l.unit_information AS lease_old_code,
              u.property_id, p.display_name AS property_name, u.name AS unit_name,
              t.first_name, t.last_name,
              nl.start_date AS next_checkin, nl.unit_information AS lease_new_code,
              nt.first_name AS next_first, nt.last_name AS next_last,
              cn.id AS cn_id, cn.old_code, cn.new_code, cn.assigned_user_id, cn.notes,
              usr.first_name AS user_first, usr.last_name AS user_last,
              cc.cleaning_date AS checkout_date
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id AND p.org_id = ?
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN leasing nl ON nl.unit_id = l.unit_id AND nl.deleted_at IS NULL
         AND nl.start_date = (SELECT MIN(nl2.start_date) FROM leasing nl2 WHERE nl2.unit_id = l.unit_id AND nl2.start_date > l.end_date AND nl2.deleted_at IS NULL)
       LEFT JOIN tenant nt ON nl.tenant_id = nt.id
       LEFT JOIN checkout_notes cn ON cn.lease_id = l.id AND cn.org_id = ?
       LEFT JOIN user usr ON cn.assigned_user_id = usr.id
       LEFT JOIN checkout_cleaning cc ON cc.lease_id = l.id AND cc.org_id = ?
       WHERE l.end_date >= ? AND l.end_date <= ? AND l.deleted_at IS NULL
       ORDER BY p.display_name, u.name, l.end_date`,
      [orgId, orgId, orgId, weekStart, weekEnd]
    );

    // Auto-create checkout_notes rows for leases that don't have one
    const toCreate = rows.filter(r => !r.cn_id);
    for (const r of toCreate) {
      const id = genId();
      await req.pool.execute(
        `INSERT INTO checkout_notes (id, org_id, lease_id, unit_id, property_id, old_code, new_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, orgId, r.lease_id, r.unit_id, r.property_id, r.lease_old_code || null, r.lease_new_code || null]
      );
      r.cn_id = id;
      r.old_code = r.lease_old_code || null;
      r.new_code = r.lease_new_code || null;
    }

    const data = rows.map(r => ({
      id: r.cn_id,
      lease_id: r.lease_id,
      property_id: r.property_id,
      property_name: r.property_name,
      unit_name: r.unit_name,
      lease_end: r.lease_end,
      checkout_date: r.checkout_date || null,
      next_checkin: r.next_checkin || null,
      old_code: r.old_code ?? r.lease_old_code ?? null,
      new_code: r.new_code ?? r.lease_new_code ?? null,
      assigned_user_id: r.assigned_user_id || null,
      assigned_user_name: [r.user_first, r.user_last].filter(Boolean).join(' ') || null,
      notes: r.notes || null,
    }));

    res.json({ code: 200, data });
  } catch (error) {
    console.error('Get checkout notes error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load checkout notes' });
  }
});

// PUT /api/cleaning/checkout-notes/:id
router.put('/checkout-notes/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const updates = [];
    const params = [];

    if (req.body.old_code !== undefined) { updates.push('old_code = ?'); params.push(req.body.old_code || null); }
    if (req.body.new_code !== undefined) { updates.push('new_code = ?'); params.push(req.body.new_code || null); }
    if (req.body.assigned_user_id !== undefined) { updates.push('assigned_user_id = ?'); params.push(req.body.assigned_user_id || null); }
    if (req.body.notes !== undefined) { updates.push('notes = ?'); params.push(req.body.notes || null); }

    if (updates.length === 0) return res.json({ code: 200, message: 'Nothing to update' });

    updates.push('updated_at = NOW()');
    params.push(id, orgId);
    await req.pool.execute(
      `UPDATE checkout_notes SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );
    res.json({ code: 200, message: 'Checkout notes updated' });
  } catch (error) {
    console.error('Update checkout notes error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update checkout notes' });
  }
});

module.exports = router;

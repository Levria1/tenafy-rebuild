const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { PLACEHOLDERS, applyPlaceholders, resolveUnitValues } = require('../services/advertisingTemplate');

// Snowflake id (same pattern used across the app).
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

// Column length caps (match migrations-org/015). Returns an error string when a
// field is too long, so we can 400 instead of letting MySQL 500 on truncation.
const FIELD_LIMITS = { name: 160, title: 255, webpage_link: 500, label: 255, forum_rule: 500 };
function lengthError(body) {
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const v = body[field];
    if (v != null && String(v).length > max) {
      return `${field} must be ${max} characters or fewer`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Advertising → Vacancy
// Units that need advertising, in two categories:
//   1. VACANT NOW  — active unit with no current lease AND no upcoming lease
//      (a tenant left, or a brand-new unit never leased). The MOST urgent.
//   2. EXPIRING    — a current lease is ending within its renewal-intent lead
//      window and no replacement is lined up.
//
// Units whose name/property contains "test" are excluded (placeholder data).
//
// Keyed off DATE-COMPUTED lease status (start_date/end_date/CURDATE()), NOT the
// stored `leasing.status` column — that column is not maintained on expiry.
//
// Lead windows (contract_type): NR(3)=45d, UC(4)=30d, MR/MTM/unset=20d.
// Sorted by urgency: longest-vacant first, then soonest-to-expire, then
// never-leased units last.
// ---------------------------------------------------------------------------

const LEAD_DAYS = { NR: 45, UC: 30, DEFAULT: 20 };
const LEAD_SQL = `CASE l.contract_type WHEN 3 THEN ${LEAD_DAYS.NR} WHEN 4 THEN ${LEAD_DAYS.UC} ELSE ${LEAD_DAYS.DEFAULT} END`;
const INTENT = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };

const TENANT_NAME_SQL = `CASE WHEN t.type = 1 THEN t.company_name
       ELSE TRIM(CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))) END`;

// Sub-conditions reused for the "vacant now" query (correlated on u.id).
const NO_CURRENT_LEASE = `NOT EXISTS (
  SELECT 1 FROM leasing lc
   WHERE lc.unit_id = u.id AND lc.deleted_at IS NULL
     AND lc.start_date <= CURDATE() AND (lc.end_date IS NULL OR lc.end_date >= CURDATE()))`;
const NO_UPCOMING_LEASE = `NOT EXISTS (
  SELECT 1 FROM leasing lu
   WHERE lu.unit_id = u.id AND lu.deleted_at IS NULL AND lu.start_date > CURDATE())`;

// Exclude placeholder/test units by name (unit or property). Substring match —
// catches "Test Unit 1", "6A Test", "Test Property 2".
const NOT_TEST = `LOWER(u.name) NOT LIKE '%test%' AND LOWER(p.display_name) NOT LIKE '%test%'`;

// Shared vacancy computation — used by BOTH /vacancies and /scheduler so they can
// never diverge. Returns the unified, urgency-sorted list plus per-category counts.
async function computeVacancies(pool, orgId) {
    // 1. EXPIRING — current lease ending within its lead window, not re-let.
    const [expiring] = await pool.execute(
      `SELECT
          l.id AS lease_id, l.contract_type, l.amount AS rent, l.deposit,
          DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
          DATEDIFF(l.end_date, CURDATE()) AS days_left,
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.advertising_template_id AS template_id, at.name AS template_name,
          p.id AS property_id, p.display_name AS property_name, p.street_address,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ?
         AND l.deleted_at IS NULL
         AND u.active_status = 1
         AND l.start_date <= CURDATE()
         AND l.end_date IS NOT NULL
         AND l.end_date >= CURDATE()
         AND DATEDIFF(l.end_date, CURDATE()) <= ${LEAD_SQL}
         AND ${NOT_TEST}
         AND NOT EXISTS (
           -- a replacement/continuation lease that keeps the unit occupied past
           -- this one's end. Uses end_date (not start>end) so a same-day rollover
           -- or overlapping renewal is correctly treated as "already re-let".
           SELECT 1 FROM leasing l2
            WHERE l2.unit_id = l.unit_id AND l2.deleted_at IS NULL
              AND l2.id <> l.id AND (l2.end_date IS NULL OR l2.end_date > l.end_date))
       ORDER BY days_left ASC`,
      [orgId]
    );

    // 2. VACANT NOW — active unit with no current AND no upcoming lease. Pull the
    // most-recent ended lease (for "vacant since" + last tenant/rent reference);
    // NULL for a never-leased unit.
    const [vacant] = await pool.execute(
      `SELECT
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.advertising_template_id AS template_id, at.name AS template_name,
          p.id AS property_id, p.display_name AS property_name, p.street_address,
          DATE_FORMAT(ll.end_date, '%Y-%m-%d') AS vacant_since,
          DATEDIFF(CURDATE(), ll.end_date) AS days_vacant,
          ll.amount AS rent, ll.deposit, ll.contract_type,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
       LEFT JOIN leasing ll ON ll.id = (
          SELECT le.id FROM leasing le
           WHERE le.unit_id = u.id AND le.deleted_at IS NULL
             AND le.end_date IS NOT NULL AND le.end_date < CURDATE()
           ORDER BY le.end_date DESC, le.id DESC LIMIT 1)
       LEFT JOIN tenant t ON t.id = ll.tenant_id
       WHERE p.org_id = ?
         AND u.active_status = 1
         AND ${NOT_TEST}
         AND ${NO_CURRENT_LEASE}
         AND ${NO_UPCOMING_LEASE}`,
      [orgId]
    );

    const expiringRows = expiring.map(r => ({
      status: 'expiring',
      lease_id: String(r.lease_id),
      contract_type: r.contract_type,
      intent: INTENT[r.contract_type] || 'Unset',
      days_left: r.days_left != null ? Number(r.days_left) : null,   // days until vacant (positive)
      end_date: r.end_date,
      vacant_since: null,
      rent: r.rent != null ? Number(r.rent) : null,
      deposit: r.deposit != null ? Number(r.deposit) : null,
      unit_id: String(r.unit_id), unit_name: r.unit_name, unit_type: r.unit_type,
      beds: r.beds != null ? Number(r.beds) : null,
      baths: r.baths != null ? Number(r.baths) : null,
      size: r.size != null ? Number(r.size) : null,
      template_id: r.template_id ? String(r.template_id) : null,
      template_name: r.template_name || null,
      property_id: String(r.property_id), property_name: r.property_name, street_address: r.street_address,
      tenant_id: r.tenant_id ? String(r.tenant_id) : null,
      tenant_name: (r.tenant_name || '').trim() || '(no tenant)',
    }));

    const vacantRows = vacant.map(r => {
      // days_vacant computed by the DB (DATEDIFF) so it agrees with CURDATE()/
      // end_date and can't drift a day from server-vs-DB timezone.
      const daysVacant = r.days_vacant != null ? Number(r.days_vacant) : null;
      return {
        status: 'vacant',
        lease_id: null,
        contract_type: null,
        intent: null,
        // Negative = already vacant N days; null = never leased.
        days_left: daysVacant != null ? -daysVacant : null,
        days_vacant: daysVacant,
        end_date: null,
        vacant_since: r.vacant_since,   // null when never leased
        rent: r.rent != null ? Number(r.rent) : null,      // last lease rent (reference)
        deposit: r.deposit != null ? Number(r.deposit) : null,
        unit_id: String(r.unit_id), unit_name: r.unit_name, unit_type: r.unit_type,
        beds: r.beds != null ? Number(r.beds) : null,
        baths: r.baths != null ? Number(r.baths) : null,
        size: r.size != null ? Number(r.size) : null,
        template_id: r.template_id ? String(r.template_id) : null,
        template_name: r.template_name || null,
        property_id: String(r.property_id), property_name: r.property_name, street_address: r.street_address,
        tenant_id: r.tenant_id ? String(r.tenant_id) : null,   // last tenant
        tenant_name: (r.tenant_name || '').trim() || null,
      };
    });

    // Urgency sort: longest-vacant (most negative) → soonest-expiring (small
    // positive) → later-expiring → never-leased (no date) last.
    const NEVER_LEASED = Number.POSITIVE_INFINITY;
    const sortKey = (x) => (x.days_left == null ? NEVER_LEASED : x.days_left);
    const vacancies = [...vacantRows, ...expiringRows].sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return (a.property_name || '').localeCompare(b.property_name || '');
    });

    return { vacancies, vacant_count: vacantRows.length, expiring_count: expiringRows.length };
}

router.get('/vacancies', authenticate, async (req, res) => {
  try {
    const { vacancies, vacant_count, expiring_count } = await computeVacancies(req.pool, req.user.orgId);
    res.json({
      code: 200,
      data: {
        as_of: new Date().toISOString().slice(0, 10),
        lead_days: LEAD_DAYS,
        count: vacancies.length,
        vacant_count,
        expiring_count,
        vacancies,
      },
    });
  } catch (err) {
    console.error('[advertising/vacancies] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load vacancies' });
  }
});

// ===========================================================================
// Advertising → Templates
// "What to post" for a unit's listing: ad copy (with %placeholders%) + webpage
// link. Reusable across many units; each unit references at most one template.
// (Forum / Facebook account / schedule live in the Scheduler — not here.)
// ===========================================================================

// List available placeholder tokens (for the editor).
router.get('/templates/placeholders', authenticate, (req, res) => {
  res.json({ code: 200, data: PLACEHOLDERS });
});

// Active units (grouped-friendly) with their currently-assigned template — for
// the assignment picker. `assigned_template_id` lets the UI show/keep existing
// assignments and warn when reassigning a unit that already has a template.
router.get('/templates/assignable-units', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name,
              p.id AS property_id, p.display_name AS property_name,
              u.advertising_template_id
         FROM unit u JOIN property p ON u.property_id = p.id
        WHERE p.org_id = ? AND u.active_status = 1
        ORDER BY p.display_name, u.name`,
      [orgId]
    );
    res.json({
      code: 200,
      data: rows.map(r => ({
        unit_id: String(r.unit_id),
        unit_name: r.unit_name,
        property_id: String(r.property_id),
        property_name: r.property_name,
        assigned_template_id: r.advertising_template_id ? String(r.advertising_template_id) : null,
      })),
    });
  } catch (err) {
    console.error('[advertising/assignable-units] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load units' });
  }
});

// List templates with their assigned-unit count.
router.get('/templates', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT a.id, a.name, a.title, a.body, a.webpage_link, a.status,
              a.created_at, a.updated_at,
              (SELECT COUNT(*) FROM unit u WHERE u.advertising_template_id = a.id AND u.active_status = 1) AS unit_count
         FROM advertising_template a
        WHERE a.org_id = ? AND a.deleted_at IS NULL
        ORDER BY a.name ASC`,
      [orgId]
    );
    res.json({
      code: 200,
      data: rows.map(r => ({
        id: String(r.id),
        name: r.name,
        title: r.title,
        body: r.body,
        webpage_link: r.webpage_link,
        status: r.status,
        unit_count: Number(r.unit_count) || 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('[advertising/templates list] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load templates' });
  }
});

// One template + its assigned units.
router.get('/templates/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[t]] = await req.pool.execute(
      `SELECT id, name, title, body, webpage_link, status FROM advertising_template
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!t) return res.status(404).json({ code: 404, message: 'Template not found' });
    const [units] = await req.pool.execute(
      `SELECT u.id, u.name AS unit_name, p.display_name AS property_name
         FROM unit u JOIN property p ON u.property_id = p.id
        WHERE u.advertising_template_id = ? AND p.org_id = ? AND u.active_status = 1
        ORDER BY p.display_name, u.name`,
      [req.params.id, orgId]
    );
    res.json({
      code: 200,
      data: {
        id: String(t.id), name: t.name, title: t.title, body: t.body,
        webpage_link: t.webpage_link, status: t.status,
        units: units.map(u => ({ id: String(u.id), unit_name: u.unit_name, property_name: u.property_name })),
      },
    });
  } catch (err) {
    console.error('[advertising/templates get] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load template' });
  }
});

// Create.
router.post('/templates', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { name, title, body, webpage_link } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, message: 'Template name is required' });
    }
    const lenErr = lengthError({ name, title, webpage_link });
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_template (id, org_id, name, title, body, webpage_link, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, orgId, String(name).trim(), title || null, body || null, webpage_link || null]
    );
    res.json({ code: 200, data: { id } });
  } catch (err) {
    console.error('[advertising/templates create] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create template' });
  }
});

// Update.
router.put('/templates/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { name, title, body, webpage_link, status } = req.body || {};
    const [[exists]] = await req.pool.execute(
      `SELECT id FROM advertising_template WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!exists) return res.status(404).json({ code: 404, message: 'Template not found' });

    const lenErr = lengthError({ name, title, webpage_link });
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });

    const fields = [];
    const params = [];
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ code: 400, message: 'Template name is required' });
      fields.push('name = ?'); params.push(String(name).trim());
    }
    if (title !== undefined) { fields.push('title = ?'); params.push(title || null); }
    if (body !== undefined) { fields.push('body = ?'); params.push(body || null); }
    if (webpage_link !== undefined) { fields.push('webpage_link = ?'); params.push(webpage_link || null); }
    if (status !== undefined) { fields.push('status = ?'); params.push(Number(status) ? 1 : 0); }
    if (!fields.length) return res.json({ code: 200, data: { id: String(req.params.id) } });

    params.push(req.params.id, orgId);
    await req.pool.execute(
      `UPDATE advertising_template SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/templates update] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update template' });
  }
});

// Soft-delete + unassign its units.
router.delete('/templates/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[exists]] = await req.pool.execute(
      `SELECT id FROM advertising_template WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!exists) return res.status(404).json({ code: 404, message: 'Template not found' });
    // Atomic: unassign the units AND soft-delete the template together, so a
    // mid-failure can't leave units unassigned while the template stays live.
    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE unit SET advertising_template_id = NULL WHERE advertising_template_id = ?`,
        [req.params.id]
      );
      await conn.execute(
        `UPDATE advertising_template SET deleted_at = NOW() WHERE id = ? AND org_id = ?`,
        [req.params.id, orgId]
      );
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* already rolled back */ }
      throw e;
    } finally {
      conn.release();
    }
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/templates delete] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to delete template' });
  }
});

// Replace the set of units assigned to this template. Each unit → one template,
// so assigning here first clears these units from any other template.
router.post('/templates/:id/assign', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const templateId = req.params.id;
    const unitIds = Array.isArray(req.body && req.body.unit_ids)
      ? req.body.unit_ids.map(String) : [];

    const [[t]] = await req.pool.execute(
      `SELECT id FROM advertising_template WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [templateId, orgId]
    );
    if (!t) return res.status(404).json({ code: 404, message: 'Template not found' });

    // Atomic clear-then-set so a mid-failure can't leave the template's units
    // cleared but not reassigned. Org-scoped via the property join so a caller
    // can't touch another org's units.
    const conn = await req.pool.getConnection();
    let assigned = 0;
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE unit SET advertising_template_id = NULL WHERE advertising_template_id = ?`,
        [templateId]
      );
      if (unitIds.length) {
        const placeholders = unitIds.map(() => '?').join(',');
        const [result] = await conn.execute(
          `UPDATE unit u JOIN property p ON u.property_id = p.id
              SET u.advertising_template_id = ?
            WHERE p.org_id = ? AND u.id IN (${placeholders})`,
          [templateId, orgId, ...unitIds]
        );
        assigned = result.affectedRows || 0;   // rows actually assigned (invalid/foreign ids dropped)
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* already rolled back */ }
      throw e;
    } finally {
      conn.release();
    }
    res.json({ code: 200, data: { template_id: String(templateId), assigned, requested: unitIds.length } });
  } catch (err) {
    console.error('[advertising/templates assign] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to assign units' });
  }
});

// Render a template for a unit (placeholders filled) — preview.
router.get('/templates/:id/preview', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const unitId = req.query.unit_id;
    if (!unitId) return res.status(400).json({ code: 400, message: 'unit_id is required' });
    const [[t]] = await req.pool.execute(
      `SELECT id, name, title, body, webpage_link FROM advertising_template
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!t) return res.status(404).json({ code: 404, message: 'Template not found' });
    const values = await resolveUnitValues(req.pool, orgId, unitId, t);
    if (!values) return res.status(404).json({ code: 404, message: 'Unit not found' });
    res.json({
      code: 200,
      data: {
        title: applyPlaceholders(t.title, values),
        body: applyPlaceholders(t.body, values),
        webpage_link: t.webpage_link || null,
        values,
      },
    });
  } catch (err) {
    console.error('[advertising/templates preview] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to render preview' });
  }
});

// ===========================================================================
// Advertising → Scheduler
// A rolling, auto-ranked roster of FIXED 20 slots. Each slot is a PROPERTY,
// bundling its vacant/expiring units, ordered by urgency (longest-vacant first).
// Recomputed live from vacancy data. Below it sits the manual URGENT list, whose
// entries carry their own forum rule (added by hand for extra postings).
// ===========================================================================

const SCHEDULER_SLOTS = 20;

function parseUnitIds(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(String) : []; }
  catch { return []; }
}

router.get('/scheduler', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { vacancies } = await computeVacancies(req.pool, orgId);

    // Bundle by (property AND template) — units post together ONLY when they share
    // both. A unit with no template can't bundle, so it gets its own slot (keyed by
    // unit id) flagged as needing a template. PRESERVES urgency order (vacancies is
    // already sorted most-urgent first → first-seen group = most-urgent group).
    const groups = new Map();
    for (const v of vacancies) {
      // templated units bundle by property+template; un-templated stand alone.
      const key = v.template_id
        ? `p:${v.property_id}|t:${v.template_id}`
        : `p:${v.property_id}|u:${v.unit_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          property_id: v.property_id, property_name: v.property_name,
          template_id: v.template_id, template_name: v.template_name, units: [],
        });
      }
      const availableDate = v.status === 'vacant' ? v.vacant_since : v.end_date;
      groups.get(key).units.push({
        unit_id: v.unit_id, unit_name: v.unit_name, status: v.status,
        days_left: v.days_left, available_date: availableDate,
      });
    }

    const bundles = [...groups.values()];
    const slots = [];
    for (let i = 0; i < SCHEDULER_SLOTS; i++) {
      const g = bundles[i];
      if (!g) {
        slots.push({ position: i + 1, property_id: null, property_name: null, template_id: null, template_name: null, unit_names: null, units: [], vacant_date: null });
        continue;
      }
      const dates = g.units.map(u => u.available_date).filter(Boolean).sort();
      slots.push({
        position: i + 1,
        property_id: g.property_id,
        property_name: g.property_name,
        template_id: g.template_id,
        template_name: g.template_name,       // null → "needs template"
        unit_names: g.units.map(u => u.unit_name).join(', '),
        units: g.units,
        vacant_date: dates[0] || null,        // earliest availability among the bundle
      });
    }

    // Manual urgent entries (resolve property name, parse bundled unit ids).
    const [urgentRows] = await req.pool.execute(
      `SELECT a.id, a.property_id, a.unit_ids, a.label, a.forum_rule, a.note, a.position,
              p.display_name AS property_name
         FROM advertising_urgent a
         LEFT JOIN property p ON p.id = a.property_id AND p.org_id = a.org_id
        WHERE a.org_id = ? AND a.deleted_at IS NULL
        ORDER BY a.position ASC, a.created_at ASC`,
      [orgId]
    );
    const urgent = urgentRows.map(r => ({
      id: String(r.id),
      property_id: r.property_id ? String(r.property_id) : null,
      property_name: r.property_name || null,
      unit_ids: parseUnitIds(r.unit_ids),
      label: r.label,
      forum_rule: r.forum_rule,
      note: r.note,
      position: Number(r.position) || 0,
    }));

    res.json({
      code: 200,
      data: {
        as_of: new Date().toISOString().slice(0, 10),
        slot_count: SCHEDULER_SLOTS,
        filled: Math.min(bundles.length, SCHEDULER_SLOTS),
        overflow: Math.max(bundles.length - SCHEDULER_SLOTS, 0),  // bundles beyond the 20 slots
        slots,
        urgent,
      },
    });
  } catch (err) {
    console.error('[advertising/scheduler] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load scheduler' });
  }
});

// Add a manual urgent entry.
router.post('/scheduler/urgent', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { property_id, unit_ids, label, forum_rule, note, position } = req.body || {};
    if (!property_id && !label && !(Array.isArray(unit_ids) && unit_ids.length)) {
      return res.status(400).json({ code: 400, message: 'Provide a property, units, or a label' });
    }
    const lenErr = lengthError({ label, forum_rule });
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    // If a property is given, verify it belongs to this org.
    if (property_id) {
      const [[p]] = await req.pool.execute(
        `SELECT id FROM property WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
        [String(property_id), orgId]
      );
      if (!p) return res.status(400).json({ code: 400, message: 'Unknown property' });
    }
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_urgent (id, org_id, property_id, unit_ids, label, forum_rule, note, position, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, orgId, property_id ? String(property_id) : null,
       Array.isArray(unit_ids) && unit_ids.length ? JSON.stringify(unit_ids.map(String)) : null,
       label || null, forum_rule || null, note || null, Number.isInteger(position) ? position : 0]
    );
    res.json({ code: 200, data: { id } });
  } catch (err) {
    console.error('[advertising/scheduler urgent create] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to add urgent entry' });
  }
});

// Update a manual urgent entry.
router.put('/scheduler/urgent/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[exists]] = await req.pool.execute(
      `SELECT id FROM advertising_urgent WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!exists) return res.status(404).json({ code: 404, message: 'Urgent entry not found' });
    const { property_id, unit_ids, label, forum_rule, note, position } = req.body || {};

    const lenErr = lengthError({ label, forum_rule });
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    // Same property-exists check as POST — don't let PUT point at a foreign/unknown property.
    if (property_id != null && property_id !== '') {
      const [[p]] = await req.pool.execute(
        `SELECT id FROM property WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
        [String(property_id), orgId]
      );
      if (!p) return res.status(400).json({ code: 400, message: 'Unknown property' });
    }
    // A malformed position must not silently overwrite the stored value with 0.
    if (position !== undefined && position !== null && !Number.isInteger(position)) {
      return res.status(400).json({ code: 400, message: 'position must be an integer' });
    }

    const fields = [];
    const params = [];
    if (property_id !== undefined) { fields.push('property_id = ?'); params.push(property_id ? String(property_id) : null); }
    if (unit_ids !== undefined) { fields.push('unit_ids = ?'); params.push(Array.isArray(unit_ids) && unit_ids.length ? JSON.stringify(unit_ids.map(String)) : null); }
    if (label !== undefined) { fields.push('label = ?'); params.push(label || null); }
    if (forum_rule !== undefined) { fields.push('forum_rule = ?'); params.push(forum_rule || null); }
    if (note !== undefined) { fields.push('note = ?'); params.push(note || null); }
    if (Number.isInteger(position)) { fields.push('position = ?'); params.push(position); }
    if (!fields.length) return res.json({ code: 200, data: { id: String(req.params.id) } });
    params.push(req.params.id, orgId);
    await req.pool.execute(
      `UPDATE advertising_urgent SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/scheduler urgent update] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update urgent entry' });
  }
});

// Remove a manual urgent entry.
router.delete('/scheduler/urgent/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [result] = await req.pool.execute(
      `UPDATE advertising_urgent SET deleted_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [req.params.id, orgId]
    );
    if (!result.affectedRows) return res.status(404).json({ code: 404, message: 'Urgent entry not found' });
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/scheduler urgent delete] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to remove urgent entry' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { PLACEHOLDERS, applyPlaceholders, resolveUnitValues, computePostingRent, convertBold } = require('../services/advertisingTemplate');
const { DAY_NAMES, weekdayOf, postsOnDay, parseDays, validateDays, dayLabel } = require('../utils/advertisingSchedule');
const { hkDate } = require('../utils/inquiryFacts');

// Snowflake id (same pattern used across the app).
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

// Column length caps (match migrations-org/015). Returns an error string when a
// field is too long, so we can 400 instead of letting MySQL 500 on truncation.
const FIELD_LIMITS = { name: 160, title: 255, webpage_link: 500, label: 255, forum_rule: 500 };
const UNIT_LINE_LIMITS = { name: 160, line_text: 500 };
function lengthError(body, limits = FIELD_LIMITS) {
  for (const [field, max] of Object.entries(limits)) {
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
// Expiring window: a FLAT 60 days for ALL renewal intents (any current lease
// ending within 60 days shows up, regardless of NR/UC/MR/MTM/unset). The renewal
// intent is displayed as a badge only — it no longer changes the window.
// (Was per-intent NR 60 / UC 30 / others 20; flattened per request 2026-08-03.)
// Sorted by urgency: longest-vacant first, then soonest-to-expire, then
// never-leased units last.
// ---------------------------------------------------------------------------

const EXPIRING_WINDOW = 60;   // days before lease end, all intents
const INTENT = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };

const tenantNameSql = (a) => `CASE WHEN ${a}.type = 1 THEN ${a}.company_name
       ELSE TRIM(CONCAT(COALESCE(${a}.first_name,''), ' ', COALESCE(${a}.last_name,''))) END`;
const TENANT_NAME_SQL = tenantNameSql('t');

// The unit's NEXT upcoming lease (earliest start > today) → next move-in date +
// tenant. Used by the "vacant now" query so the Leasing → Vacancy page can show a
// unit that is empty TODAY even when someone is moving in later (for viewings).
const NEXT_MOVE_IN_JOIN = `
       LEFT JOIN leasing nl ON nl.id = (
         SELECT lm.id FROM leasing lm
          WHERE lm.unit_id = u.id AND lm.deleted_at IS NULL AND lm.start_date > CURDATE()
          ORDER BY lm.start_date ASC LIMIT 1)
       LEFT JOIN tenant nt ON nt.id = nl.tenant_id`;
const NEXT_MOVE_IN_COLS = `
          DATE_FORMAT(nl.start_date, '%Y-%m-%d') AS next_move_in_date,
          DATEDIFF(nl.start_date, CURDATE()) AS days_to_move_in,
          nl.tenant_id AS next_tenant_id, ${tenantNameSql('nt')} AS next_tenant_name`;

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
// `page` view (Leasing → Vacancy) differs from the Advertising SCHEDULER view:
//   - EXPIRING: page requires the lease to be CURRENT (occupied today); the
//     scheduler keeps the broader "latest lease ends soon incl. a future one"
//     (so it still advertises a re-let-then-vacant gap). Empty-today units with a
//     short upcoming lease therefore move OUT of expiring and INTO vacant on the
//     page (shown as "vacant now + next move-in").
//   - VACANT: page includes units that are empty TODAY even if a move-in is
//     booked; the scheduler stays "truly open" (no upcoming) so it never
//     advertises a unit that is already filling.
async function computeVacancies(pool, orgId, { page = false } = {}) {
    // 1. EXPIRING — the unit's LATEST lease (current OR a future one) ends within
    //    the window and nothing follows it. We intentionally do NOT require the
    //    lease to have started: a unit re-let with a SHORT upcoming lease (e.g.
    //    current ends soon, a brief future lease runs a couple weeks, then nothing)
    //    genuinely goes vacant at that future end — the NOT EXISTS below already
    //    isolates the last lease, so dropping the start_date filter surfaces it.
    //    A unit re-let with a LONG future lease stays hidden (its end is >window).
    const [expiring] = await pool.execute(
      `SELECT
          l.id AS lease_id, l.contract_type, l.amount AS rent, l.deposit, l.notice_period_days,
          DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
          DATEDIFF(l.end_date, CURDATE()) AS days_left,
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.rent_price_min, u.rent_price_max,
          at.id AS template_id, at.name AS template_name,
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
         ${page ? 'AND l.start_date <= CURDATE()' : ''}
         AND l.end_date IS NOT NULL
         AND l.end_date >= CURDATE()
         AND DATEDIFF(l.end_date, CURDATE()) <= ${EXPIRING_WINDOW}
         AND ${NOT_TEST}
         AND NOT EXISTS (
           -- a replacement/continuation lease that keeps the unit occupied past
           -- this one's end. Uses end_date (not start>end) so a same-day rollover
           -- or overlapping renewal is correctly treated as "already re-let". The
           -- id tie-break ensures that if two leases share the SAME max end_date
           -- (e.g. a duplicate/re-entered row) only the highest-id one survives, so
           -- the unit can't appear twice now that the start_date filter is gone.
           SELECT 1 FROM leasing l2
            WHERE l2.unit_id = l.unit_id AND l2.deleted_at IS NULL
              AND l2.id <> l.id
              AND (l2.end_date IS NULL
                   OR l2.end_date > l.end_date
                   OR (l2.end_date = l.end_date AND l2.id > l.id)))
       ORDER BY days_left ASC`,
      [orgId]
    );

    // 2. VACANT NOW — active unit with no current AND no upcoming lease. Pull the
    // most-recent ended lease (for "vacant since" + last tenant/rent reference);
    // NULL for a never-leased unit.
    const [vacant] = await pool.execute(
      `SELECT
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.rent_price_min, u.rent_price_max,
          at.id AS template_id, at.name AS template_name,
          p.id AS property_id, p.display_name AS property_name, p.street_address,
          ll.id AS last_lease_id,
          DATE_FORMAT(ll.end_date, '%Y-%m-%d') AS vacant_since,
          DATEDIFF(CURDATE(), ll.end_date) AS days_vacant,
          ll.amount AS rent, ll.deposit, ll.contract_type,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name${page ? ',' + NEXT_MOVE_IN_COLS : ''}
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
       LEFT JOIN leasing ll ON ll.id = (
          SELECT le.id FROM leasing le
           WHERE le.unit_id = u.id AND le.deleted_at IS NULL
             AND le.end_date IS NOT NULL AND le.end_date < CURDATE()
           ORDER BY le.end_date DESC, le.id DESC LIMIT 1)
       LEFT JOIN tenant t ON t.id = ll.tenant_id${page ? NEXT_MOVE_IN_JOIN : ''}
       WHERE p.org_id = ?
         AND u.active_status = 1
         AND ${NOT_TEST}
         AND ${NO_CURRENT_LEASE}
         ${page ? '' : 'AND ' + NO_UPCOMING_LEASE}`,
      [orgId]
    );

    const moveoutByLease = {};
    const moveoutLeaseIds = [
      ...expiring.map(r => r.lease_id),
      ...vacant.map(r => r.last_lease_id),
    ].filter(Boolean);
    if (moveoutLeaseIds.length > 0) {
      try {
        const placeholders = moveoutLeaseIds.map(() => '?').join(',');
        const [moveouts] = await pool.execute(
          `SELECT m.leasing_id, m.notes,
                  (m.original_end_date IS NOT NULL AND m.requested_date < m.original_end_date) AS moved_out_early
             FROM lease_moveout_request m
            WHERE m.org_id = ?
              AND m.leasing_id IN (${placeholders})
              AND m.status = 'approved'
              AND m.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM lease_moveout_request m2
                 WHERE m2.org_id = m.org_id
                   AND m2.leasing_id = m.leasing_id
                   AND m2.status = 'approved'
                   AND m2.deleted_at IS NULL
                   AND (m2.created_at > m.created_at OR (m2.created_at = m.created_at AND m2.id > m.id))
              )`,
          [orgId, ...moveoutLeaseIds]
        );
        for (const m of moveouts) {
          moveoutByLease[String(m.leasing_id)] = {
            moveout_notes: m.notes || null,
            // bigNumberStrings:true makes a SQL boolean arrive as "0"/"1", and
            // !!"0" is TRUE — compare numerically.
            moved_out_early: Number(m.moved_out_early) === 1,
          };
        }
      } catch (e) {
        console.error('[advertising/vacancies] move-out lookup skipped:', e.message);
      }
    }

    const expiringRows = expiring.map(r => ({
      status: 'expiring',
      lease_id: String(r.lease_id),
      contract_type: r.contract_type,
      notice_period_days: r.notice_period_days != null ? Number(r.notice_period_days) : null,
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
      rent_price_min: r.rent_price_min != null ? Number(r.rent_price_min) : null,
      rent_price_max: r.rent_price_max != null ? Number(r.rent_price_max) : null,
      template_id: r.template_id ? String(r.template_id) : null,
      template_name: r.template_name || null,
      property_id: String(r.property_id), property_name: r.property_name, street_address: r.street_address,
      tenant_id: r.tenant_id ? String(r.tenant_id) : null,
      tenant_name: (r.tenant_name || '').trim() || '(no tenant)',
      moveout_notes: moveoutByLease[String(r.lease_id)]?.moveout_notes || null,
      moved_out_early: !!moveoutByLease[String(r.lease_id)]?.moved_out_early,
      // Expiring rows are (page) NOT re-let, so there is no upcoming move-in.
      next_move_in_date: null, days_to_move_in: null, next_tenant_id: null, next_tenant_name: null,
    }));

    const vacantRows = vacant.map(r => {
      // days_vacant computed by the DB (DATEDIFF) so it agrees with CURDATE()/
      // end_date and can't drift a day from server-vs-DB timezone.
      const daysVacant = r.days_vacant != null ? Number(r.days_vacant) : null;
      return {
        status: 'vacant',
        lease_id: null,
        contract_type: null,
        notice_period_days: null,   // no current lease → no notice period
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
        rent_price_min: r.rent_price_min != null ? Number(r.rent_price_min) : null,
        rent_price_max: r.rent_price_max != null ? Number(r.rent_price_max) : null,
        template_id: r.template_id ? String(r.template_id) : null,
        template_name: r.template_name || null,
        property_id: String(r.property_id), property_name: r.property_name, street_address: r.street_address,
        tenant_id: r.tenant_id ? String(r.tenant_id) : null,   // last tenant
        tenant_name: (r.tenant_name || '').trim() || null,
        moveout_notes: moveoutByLease[String(r.last_lease_id)]?.moveout_notes || null,
        moved_out_early: !!moveoutByLease[String(r.last_lease_id)]?.moved_out_early,
        // Next upcoming lease (a booked move-in even though it's empty today).
        next_move_in_date: r.next_move_in_date || null,
        days_to_move_in: r.days_to_move_in != null ? Number(r.days_to_move_in) : null,
        next_tenant_id: r.next_tenant_id ? String(r.next_tenant_id) : null,
        next_tenant_name: (r.next_tenant_name || '').trim() || null,
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
    const { vacancies, vacant_count, expiring_count } = await computeVacancies(req.pool, req.user.orgId, { page: true });
    res.json({
      code: 200,
      data: {
        as_of: new Date().toISOString().slice(0, 10),
        lead_days: EXPIRING_WINDOW,
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
      `SELECT a.id, a.name, a.title, a.body, a.per_unit_line, a.unit_line_id, a.webpage_link, a.status,
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
        per_unit_line: r.per_unit_line,
        unit_line_id: r.unit_line_id != null ? String(r.unit_line_id) : null,
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
      `SELECT id, name, title, body, per_unit_line, unit_line_id, webpage_link, status FROM advertising_template
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
        per_unit_line: t.per_unit_line, unit_line_id: t.unit_line_id != null ? String(t.unit_line_id) : null,
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
    const { name, title, body, per_unit_line, unit_line_id, webpage_link } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: 400, message: 'Template name is required' });
    }
    const lenErr = lengthError({ name, title, webpage_link });
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_template (id, org_id, name, title, body, per_unit_line, unit_line_id, webpage_link, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, orgId, String(name).trim(), title || null, body || null, per_unit_line || null, unit_line_id || null, webpage_link || null]
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
    const { name, title, body, per_unit_line, unit_line_id, webpage_link, status } = req.body || {};
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
    if (per_unit_line !== undefined) { fields.push('per_unit_line = ?'); params.push(per_unit_line || null); }
    if (unit_line_id !== undefined) { fields.push('unit_line_id = ?'); params.push(unit_line_id || null); }
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
      `SELECT id, name, title, body, per_unit_line, unit_line_id, webpage_link FROM advertising_template
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!t) return res.status(404).json({ code: 404, message: 'Template not found' });
    const values = await resolveUnitValues(req.pool, orgId, unitId, t);
    if (!values) return res.status(404).json({ code: 404, message: 'Unit not found' });
    const perUnitLine = await resolveUnitLine(req.pool, orgId, t);
    const settings = await loadSettings(req.pool, orgId);
    // Assemble the FULL post exactly like renderBundle (single unit): first line,
    // body, per-unit line, webpage link, footer — blank-line joined, bolded once.
    const rawParts = [
      applyPlaceholders(t.title, values),
      applyPlaceholders(t.body, values),
      applyPlaceholders(perUnitLine, values),
      t.webpage_link || '',
      settings.footer || '',
    ].map(s => (s || '').trim()).filter(Boolean);
    const post_text = convertBold(rawParts.join('\n\n'));
    res.json({
      code: 200,
      data: {
        title: convertBold(applyPlaceholders(t.title, values)),
        body: convertBold(applyPlaceholders(t.body, values)),
        per_unit_line: convertBold(applyPlaceholders(perUnitLine, values)),
        webpage_link: t.webpage_link || null,
        footer: settings.footer ? convertBold(settings.footer) : null,
        post_text,
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
const MAX_BUNDLE_UNITS = 3;   // at most 3 units per post (same property + template)

function parseUnitIds(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(String) : []; }
  catch { return []; }
}

// Group vacancy units into posts: bundle by (property AND template), cap each at
// MAX_BUNDLE_UNITS (splitting bigger groups), order by most-urgent unit. Shared by
// /scheduler and the posting plan. Un-templated units stand alone (keyed by unit).
function buildBundles(vacancies) {
  const groups = new Map();
  for (const v of vacancies) {
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
      rent_price_min: v.rent_price_min, rent_price_max: v.rent_price_max,
    });
  }
  const bundles = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.units.length; i += MAX_BUNDLE_UNITS) {
      bundles.push({
        property_id: g.property_id, property_name: g.property_name,
        template_id: g.template_id, template_name: g.template_name,
        units: g.units.slice(i, i + MAX_BUNDLE_UNITS),
      });
    }
  }
  const urgency = (b) => Math.min(...b.units.map(u => (u.days_left == null ? Number.POSITIVE_INFINITY : u.days_left)));
  bundles.sort((a, b) => {
    const ka = urgency(a), kb = urgency(b);
    if (ka !== kb) return ka - kb;
    return (a.property_name || '').localeCompare(b.property_name || '');
  });
  return bundles;
}

router.get('/scheduler', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { vacancies } = await computeVacancies(req.pool, orgId);
    const bundles = buildBundles(vacancies);

    const slots = [];
    for (let i = 0; i < SCHEDULER_SLOTS; i++) {
      const g = bundles[i];
      if (!g) {
        slots.push({ position: i + 1, property_id: null, property_name: null, template_id: null, template_name: null, unit_names: null, units: [], vacant_date: null });
        continue;
      }
      const dates = g.units.map(u => u.available_date).filter(Boolean).sort();
      // Posting rent per unit — the rate to advertise at right now, from its range
      // and time-to-availability (steps down as it nears / discount once vacant).
      const units = g.units.map(u => {
        const pr = computePostingRent(u.rent_price_min, u.rent_price_max, u.days_left);
        return { ...u, posting_rent: pr ? pr.amount : null, posting_tier: pr ? pr.tier : null };
      });
      slots.push({
        position: i + 1,
        property_id: g.property_id,
        property_name: g.property_name,
        template_id: g.template_id,
        template_name: g.template_name,       // null → "needs template"
        unit_names: g.units.map(u => u.unit_name).join(', '),
        units,
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

// ===========================================================================
// Advertising → Posting plan
// The daily instructions the PC agent calls: each bundle rendered (shared body +
// a per-unit line for each unit) and paired with a forum + a member account,
// rotated so a property doesn't reuse a forum within the week and no forum is
// used twice in the same plan. Reads/writes advertising_post_log.
// ===========================================================================

const ROTATION_WINDOW_DAYS = 7;   // don't reuse a forum for a property within a week
const PHOTO_ROOT = process.env.ADVERTISING_PHOTO_ROOT || '~/tenafy-photos';

// The default plan date must be the HONG KONG date, not the server's. Prod runs UTC
// (Etc/UTC), so from HK midnight until 08:00 the server's local date is still
// YESTERDAY — and since this feature keys the forum set off the weekday, an operator
// posting early morning HK would be handed the wrong day's forums entirely. Reuse the
// existing hkDate() rather than a second conversion.
function todayYmd() {
  return hkDate(new Date().toISOString());
}

// Render a bundle's post text. The shared first line + body are rendered from the
// LOWEST-priced unit's values (so "…and Up" quotes the cheapest of a bundle), then
// one per-unit line per unit (in bundle order), then the webpage link, then the
// org-wide footer. `footer` comes from advertising_setting.
// Resolve a template's effective per-unit line: the preset it points at
// (unit_line_id) → the org's is_default preset → the template's own legacy
// per_unit_line column. Guarded so an un-migrated org DB (no advertising_unit_line
// table yet) simply falls back to the legacy column instead of 500-ing.
async function resolveUnitLine(pool, orgId, template) {
  try {
    if (template && template.unit_line_id) {
      const [[p]] = await pool.execute(
        `SELECT line_text FROM advertising_unit_line
          WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
        [template.unit_line_id, orgId]);
      if (p && p.line_text) return p.line_text;
    }
    // ORDER BY id makes the pick deterministic even if two rows are is_default=1
    // (e.g. a rare concurrent first-create race).
    const [[d]] = await pool.execute(
      `SELECT line_text FROM advertising_unit_line
        WHERE org_id = ? AND is_default = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [orgId]);
    if (d && d.line_text) return d.line_text;
  } catch (e) {
    // advertising_unit_line not migrated on this org DB — use the legacy column.
  }
  return (template && template.per_unit_line) || null;
}

async function renderBundle(pool, orgId, bundle, template, footer) {
  const resolved = [];
  for (const u of bundle.units) {
    const values = await resolveUnitValues(pool, orgId, u.unit_id, template);
    if (values) resolved.push(values);
  }
  const amt = (v) => {
    // Strip anything non-numeric ($, HKD, spaces) defensively, not just commas.
    const n = Number(String(v['%PostingRentAmount%'] || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
  };
  const sharedValues = resolved.length
    ? resolved.reduce((lo, v) => (amt(v) < amt(lo) ? v : lo), resolved[0])
    : null;
  const perUnitLine = await resolveUnitLine(pool, orgId, template);
  const unitLines = perUnitLine ? resolved.map(v => applyPlaceholders(perUnitLine, v)) : [];
  const title = sharedValues ? applyPlaceholders(template.title, sharedValues) : (template.title || '');
  const body = sharedValues ? applyPlaceholders(template.body, sharedValues) : (template.body || '');
  // Blank line between each unit block, and between the major sections (first
  // line / body / units / link / footer) for a clean, readable post.
  const parts = [title, body, unitLines.join('\n\n'), template.webpage_link || '', footer || '']
    .map(s => (s || '').trim()).filter(Boolean);
  const text = convertBold(parts.join('\n\n'));
  return { title: convertBold(title), body: convertBold(body), unit_lines: unitLines.map(convertBold),
           webpage_link: template.webpage_link || null, footer: footer || null, text };
}

// Org-wide advertising settings (shared footer + photo root).
async function loadSettings(pool, orgId) {
  const [[row]] = await pool.execute(
    `SELECT footer, photo_root FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
  return { footer: row?.footer || null, photo_root: row?.photo_root || PHOTO_ROOT };
}

router.get('/settings', authenticate, async (req, res) => {
  try {
    const s = await loadSettings(req.pool, req.user.orgId);
    res.json({ code: 200, data: s });
  } catch (err) {
    console.error('[advertising/settings get] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load settings' });
  }
});

router.put('/settings', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { footer, photo_root } = req.body || {};
    const bt = nonStringField(req.body || {}, ['footer', 'photo_root']);
    if (bt) return res.status(400).json({ code: 400, message: `${bt} must be text` });
    const lenErr = lengthError({ photo_root }, { photo_root: 255 });   // column is VARCHAR(255)
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    // PARTIAL upsert — only touch the fields actually sent, so the footer editor
    // (Templates) and photo-root (Forums) can't overwrite each other.
    const setClauses = [];
    if (footer !== undefined) setClauses.push('footer = VALUES(footer)');
    if (photo_root !== undefined) setClauses.push('photo_root = VALUES(photo_root)');
    if (!setClauses.length) return res.json({ code: 200, data: { ok: true } });
    await req.pool.execute(
      `INSERT INTO advertising_setting (org_id, footer, photo_root, created_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${setClauses.join(', ')}`,
      [orgId, footer !== undefined ? (footer || null) : null, photo_root !== undefined ? (photo_root || null) : null]
    );
    res.json({ code: 200, data: { ok: true } });
  } catch (err) {
    console.error('[advertising/settings put] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to save settings' });
  }
});

router.get('/posting-plan', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const planDate = req.query.date ? String(req.query.date) : todayYmd();
    const weekday = weekdayOf(planDate);
    if (weekday == null) return res.status(400).json({ code: 400, message: 'invalid_date' });
    const settings = await loadSettings(req.pool, orgId);
    const { vacancies } = await computeVacancies(req.pool, orgId);
    const bundles = buildBundles(vacancies);

    // Forums + their member accounts (only forums that HAVE a member are usable).
    const [forumRows] = await req.pool.execute(
      `SELECT f.id AS forum_id, f.name AS forum_name, f.url,
              f.post_days,
              a.id AS account_id, a.name AS account_name, a.email AS account_email
         FROM advertising_forum f
         JOIN advertising_forum_account fa ON fa.forum_id = f.id AND fa.org_id = f.org_id
         JOIN advertising_account a ON a.id = fa.account_id AND a.org_id = f.org_id AND a.deleted_at IS NULL AND a.status = 1
        WHERE f.org_id = ? AND f.deleted_at IS NULL AND f.status = 1
        ORDER BY f.name, a.email`,
      [orgId]
    );
    const forums = new Map(); // forum_id → { forum_id, forum_name, url, post_days, accounts: [] }
    for (const r of forumRows) {
      const k = String(r.forum_id);
      if (!forums.has(k)) forums.set(k, { forum_id: k, forum_name: r.forum_name, url: r.url, post_days: r.post_days || '', accounts: [] });
      forums.get(k).accounts.push({ id: String(r.account_id), name: r.account_name, email: r.account_email });
    }

    // Forums each property used in the rotation window (avoid reusing them).
    const [recent] = await req.pool.execute(
      `SELECT DISTINCT property_id, forum_id FROM advertising_post_log
        WHERE org_id = ? AND status = 'posted' AND forum_id IS NOT NULL
          AND post_date >= DATE_SUB(?, INTERVAL ${ROTATION_WINDOW_DAYS} DAY)
          AND post_date <= ?`,
      [orgId, planDate, planDate]
    );
    const usedByProperty = new Map(); // property_id → Set(forum_id)
    for (const r of recent) {
      const k = String(r.property_id);
      if (!usedByProperty.has(k)) usedByProperty.set(k, new Set());
      usedByProperty.get(k).add(String(r.forum_id));
    }

    const allForumIds = [...forums.keys()];
    const scheduledForumIds = allForumIds.filter(fid => postsOnDay(forums.get(fid).post_days, planDate));
    const unscheduledForumCount = allForumIds.filter(fid => parseDays(forums.get(fid).post_days).length === 0).length;
    const usedTodayForums = new Set();      // don't use a forum twice in this plan
    const accountUseCount = new Map();      // balance account load across the plan
    const templateCache = new Map();        // template_id → row (many bundles share one)
    const posts = [];

    for (const b of bundles) {
      if (!b.template_id) {
        posts.push({ ...bundleSummary(b), status: 'needs_template',
          reason: 'Assign a template before this can be posted', forum: null, account: null });
        continue;
      }
      let tpl = templateCache.get(b.template_id);
      if (tpl === undefined) {
        const [[row]] = await req.pool.execute(
          `SELECT id, name, title, body, per_unit_line, unit_line_id, webpage_link FROM advertising_template
            WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
          [b.template_id, orgId]
        );
        tpl = row || null;
        templateCache.set(b.template_id, tpl);
      }
      // Template vanished between vacancy-compute and now → don't emit an empty post.
      if (!tpl) {
        posts.push({ ...bundleSummary(b), status: 'needs_template',
          reason: 'Template was deleted', forum: null, account: null });
        continue;
      }
      const rendered = await renderBundle(req.pool, orgId, b, tpl, settings.footer);

      // Candidate forums: this property hasn't used in the window AND not used yet
      // in this plan. Fall back to any-unused-today only inside the requested day.
      const used = usedByProperty.get(String(b.property_id)) || new Set();
      let candidates = scheduledForumIds.filter(fid => !used.has(fid) && !usedTodayForums.has(fid));
      if (!candidates.length) candidates = scheduledForumIds.filter(fid => !usedTodayForums.has(fid));

      let forum = null, account = null;
      if (candidates.length) {
        const chosenId = candidates[0];
        const f = forums.get(chosenId);
        forum = { forum_id: f.forum_id, forum_name: f.forum_name, url: f.url };
        // Least-used member account, for balance.
        account = [...f.accounts].sort((x, y) =>
          (accountUseCount.get(x.id) || 0) - (accountUseCount.get(y.id) || 0))[0] || null;
        if (account) accountUseCount.set(account.id, (accountUseCount.get(account.id) || 0) + 1);
        usedTodayForums.add(chosenId);
      }

      posts.push({
        ...bundleSummary(b),
        status: forum ? 'ready' : 'no_forum',
        reason: forum ? null : `No forum scheduled for ${dayLabel(weekday)} still available`,
        template_id: String(b.template_id), template_name: b.template_name,
        post_text: rendered ? rendered.text : null,
        rendered,
        forum, account,
        image_hint: b.units.map(u => `${b.property_name}/${u.unit_name}`),
        // Other forums the human/agent could swap to (every usable forum except
        // the chosen one) scheduled for this day, each with its member accounts.
        alternatives: scheduledForumIds
          .filter(fid => !forum || fid !== forum.forum_id)
          .map(fid => { const f = forums.get(fid); return { forum_id: f.forum_id, forum_name: f.forum_name, url: f.url, accounts: f.accounts }; }),
      });
    }

    res.json({
      code: 200,
      data: {
        date: planDate,
        weekday,
        day_name: dayLabel(weekday),
        photo_root: settings.photo_root,
        forum_count: forums.size,
        scheduled_forum_count: scheduledForumIds.length,
        unscheduled_forum_count: unscheduledForumCount,
        posts,
      },
    });
  } catch (err) {
    console.error('[advertising/posting-plan] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to build posting plan' });
  }
});

function bundleSummary(b) {
  return {
    property_id: b.property_id ? String(b.property_id) : null,
    property_name: b.property_name,
    unit_ids: b.units.map(u => String(u.unit_id)),
    unit_names: b.units.map(u => u.unit_name),
  };
}

// Log a post (or skip) — idempotency + rotation history. The agent calls this
// after it (or the human) posts, so the next plan won't reuse that forum.
router.post('/posting-plan/mark', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body || {};
    const status = b.status === 'skipped' ? 'skipped' : 'posted';
    const source = b.source === 'urgent' ? 'urgent' : 'roster';
    // A given post_date is honoured only if valid; otherwise defaulted from the DB
    // (CURDATE()) below so it agrees with the CURDATE()-relative rotation window.
    const post_date = /^\d{4}-\d{2}-\d{2}$/.test(b.post_date || '') ? b.post_date : null;
    const unit_ids = Array.isArray(b.unit_ids) && b.unit_ids.length ? JSON.stringify(b.unit_ids.map(String)) : null;

    // Referenced ids must belong to THIS org — a bad/foreign id would poison the
    // rotation history (mark a property as having used a forum it never did).
    const check = async (table, id) => {
      if (!id) return null;
      const [[row]] = await req.pool.execute(
        `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
        [String(id), orgId]
      );
      if (!row) { const e = new Error(`Unknown ${table} id`); e.httpStatus = 400; throw e; }
      return String(id);
    };
    const propertyId = await check('property', b.property_id);
    const templateId = await check('advertising_template', b.template_id);
    const forumId = await check('advertising_forum', b.forum_id);
    const accountId = await check('advertising_account', b.account_id);

    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_post_log (id, org_id, post_date, property_id, template_id, forum_id, account_id, unit_ids, source, status, created_at)
       VALUES (?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, orgId, post_date, propertyId, templateId, forumId, accountId, unit_ids, source, status]
    );
    res.json({ code: 200, data: { id } });
  } catch (err) {
    if (err.httpStatus === 400) return res.status(400).json({ code: 400, message: err.message });
    console.error('[advertising/posting-plan mark] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to log post' });
  }
});

// ===========================================================================
// Advertising → Forums & Accounts
// Facebook groups (forums) + posting accounts + membership (which accounts can
// post to which forum). Feeds the Scheduler's posting-plan so it only ever pairs
// a forum with an account that is a member of it.
// ===========================================================================

const FORUM_LIMITS = { name: 255, url: 500 };
const ACCOUNT_LIMITS = { name: 160, email: 255 };

// Guard: a provided text field must be a string (a JSON object/array would slip
// past a truthiness check and make mysql2 emit invalid SQL → 500). Returns the
// offending field name, or null.
function nonStringField(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (v != null && typeof v !== 'string') return k;
  }
  return null;
}

// ---- Unit-line presets ----
// Named, reusable per-unit lines. A template points at one via unit_line_id;
// NULL uses the org's is_default preset (see resolveUnitLine).
router.get('/unit-lines', authenticate, async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT id, name, line_text, is_default, status FROM advertising_unit_line
        WHERE org_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, name ASC`,
      [req.user.orgId]
    );
    res.json({ code: 200, data: rows.map(r => ({
      id: String(r.id), name: r.name, line_text: r.line_text,
      is_default: !!r.is_default, status: r.status,
    })) });
  } catch (err) {
    console.error('[advertising/unit-lines list] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load unit lines' });
  }
});

router.post('/unit-lines', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { name, line_text } = req.body || {};
    const bt = nonStringField(req.body || {}, ['name', 'line_text']);
    if (bt) return res.status(400).json({ code: 400, message: `${bt} must be text` });
    if (!name || !String(name).trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
    const lenErr = lengthError({ name, line_text }, UNIT_LINE_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    // The first preset for an org becomes the default automatically.
    const [[{ cnt }]] = await req.pool.execute(
      `SELECT COUNT(*) AS cnt FROM advertising_unit_line WHERE org_id = ? AND deleted_at IS NULL`, [orgId]);
    const isDefault = Number(cnt) === 0 ? 1 : 0;
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_unit_line (id, org_id, name, line_text, is_default, status, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [id, orgId, String(name).trim(), line_text || null, isDefault]
    );
    res.json({ code: 200, data: { id, is_default: !!isDefault } });
  } catch (err) {
    console.error('[advertising/unit-lines create] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create unit line' });
  }
});

router.put('/unit-lines/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[exists]] = await req.pool.execute(
      `SELECT id FROM advertising_unit_line WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!exists) return res.status(404).json({ code: 404, message: 'Unit line not found' });
    const { name, line_text, status } = req.body || {};
    const bt = nonStringField(req.body || {}, ['name', 'line_text']);
    if (bt) return res.status(400).json({ code: 400, message: `${bt} must be text` });
    const lenErr = lengthError({ name, line_text }, UNIT_LINE_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const fields = [], params = [];
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
      fields.push('name = ?'); params.push(String(name).trim());
    }
    if (line_text !== undefined) { fields.push('line_text = ?'); params.push(line_text || null); }
    if (status !== undefined) { fields.push('status = ?'); params.push(Number(status) ? 1 : 0); }
    if (!fields.length) return res.json({ code: 200, data: { id: String(req.params.id) } });
    params.push(req.params.id, orgId);
    await req.pool.execute(`UPDATE advertising_unit_line SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`, params);
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/unit-lines update] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update unit line' });
  }
});

// Make this preset the org default (unset the others). NULL-referencing templates use it.
router.post('/unit-lines/:id/set-default', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[exists]] = await conn.execute(
        `SELECT id FROM advertising_unit_line WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
        [req.params.id, orgId]);
      if (!exists) { await conn.rollback(); return res.status(404).json({ code: 404, message: 'Unit line not found' }); }
      await conn.execute(`UPDATE advertising_unit_line SET is_default = 0 WHERE org_id = ?`, [orgId]);
      await conn.execute(`UPDATE advertising_unit_line SET is_default = 1 WHERE id = ? AND org_id = ?`, [req.params.id, orgId]);
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch {} throw e; } finally { conn.release(); }
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/unit-lines set-default] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to set default unit line' });
  }
});

router.delete('/unit-lines/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.execute(
        `SELECT is_default FROM advertising_unit_line WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
        [req.params.id, orgId]);
      if (!row) { await conn.rollback(); return res.status(404).json({ code: 404, message: 'Unit line not found' }); }
      await conn.execute(
        `UPDATE advertising_unit_line SET deleted_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [req.params.id, orgId]);
      // Templates pointing at it fall back to the org default.
      await conn.execute(
        `UPDATE advertising_template SET unit_line_id = NULL WHERE unit_line_id = ? AND org_id = ?`,
        [req.params.id, orgId]);
      // If we just removed the default, promote another preset so NULL-referencing
      // templates keep resolving a line.
      if (row.is_default) {
        const [[next]] = await conn.execute(
          `SELECT id FROM advertising_unit_line WHERE org_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`,
          [orgId]);
        if (next) await conn.execute(
          `UPDATE advertising_unit_line SET is_default = 1 WHERE id = ? AND org_id = ?`, [next.id, orgId]);
      }
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch {} throw e; } finally { conn.release(); }
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/unit-lines delete] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to delete unit line' });
  }
});

// ---- Accounts ----
router.get('/accounts', authenticate, async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT id, name, email, notes, status FROM advertising_account
        WHERE org_id = ? AND deleted_at IS NULL ORDER BY name, email`,
      [req.user.orgId]
    );
    res.json({ code: 200, data: rows.map(r => ({
      id: String(r.id), name: r.name, email: r.email, notes: r.notes, status: r.status,
    })) });
  } catch (err) {
    console.error('[advertising/accounts list] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load accounts' });
  }
});

router.post('/accounts', authenticate, async (req, res) => {
  try {
    const { name, email, notes } = req.body || {};
    const bt = nonStringField(req.body || {}, ['name', 'email', 'notes']);
    if (bt) return res.status(400).json({ code: 400, message: `${bt} must be text` });
    if (!name && !email) return res.status(400).json({ code: 400, message: 'Provide a name or email' });
    const lenErr = lengthError({ name, email }, ACCOUNT_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    // Reject a duplicate email (an email identifies one FB account).
    if (email) {
      const [[dup]] = await req.pool.execute(
        `SELECT id FROM advertising_account WHERE org_id = ? AND email = ? AND deleted_at IS NULL LIMIT 1`,
        [req.user.orgId, email]
      );
      if (dup) return res.status(409).json({ code: 409, message: 'An account with that email already exists' });
    }
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_account (id, org_id, name, email, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [id, req.user.orgId, name || null, email || null, notes || null]
    );
    res.json({ code: 200, data: { id } });
  } catch (err) {
    console.error('[advertising/accounts create] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create account' });
  }
});

router.put('/accounts/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[exists]] = await req.pool.execute(
      `SELECT id FROM advertising_account WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!exists) return res.status(404).json({ code: 404, message: 'Account not found' });
    const { name, email, notes, status } = req.body || {};
    const lenErr = lengthError({ name, email }, ACCOUNT_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const fields = [], params = [];
    if (name !== undefined) { fields.push('name = ?'); params.push(name || null); }
    if (email !== undefined) { fields.push('email = ?'); params.push(email || null); }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes || null); }
    if (status !== undefined) { fields.push('status = ?'); params.push(Number(status) ? 1 : 0); }
    if (!fields.length) return res.json({ code: 200, data: { id: String(req.params.id) } });
    params.push(req.params.id, orgId);
    await req.pool.execute(`UPDATE advertising_account SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`, params);
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/accounts update] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update account' });
  }
});

router.delete('/accounts/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `UPDATE advertising_account SET deleted_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [req.params.id, orgId]
      );
      if (!result.affectedRows) { await conn.rollback(); return res.status(404).json({ code: 404, message: 'Account not found' }); }
      // Drop its memberships so no forum lists a dead account.
      await conn.execute(`DELETE FROM advertising_forum_account WHERE account_id = ? AND org_id = ?`, [req.params.id, orgId]);
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch {} throw e; } finally { conn.release(); }
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/accounts delete] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to delete account' });
  }
});

// ---- Forums ---- (list includes member account ids for the membership editor)
router.get('/schedule-grid', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT f.id AS forum_id, f.name AS forum_name, f.url, f.post_days,
              a.id AS account_id, a.name AS account_name, a.email AS account_email
         FROM advertising_forum f
         LEFT JOIN advertising_forum_account fa ON fa.forum_id = f.id AND fa.org_id = f.org_id
         LEFT JOIN advertising_account a ON a.id = fa.account_id AND a.org_id = f.org_id AND a.deleted_at IS NULL AND a.status = 1
        WHERE f.org_id = ? AND f.deleted_at IS NULL AND f.status = 1
        ORDER BY f.name, a.email`,
      [orgId]
    );
    const forums = new Map();
    for (const r of rows) {
      const k = String(r.forum_id);
      if (!forums.has(k)) {
        forums.set(k, {
          forum_id: k,
          forum_name: r.forum_name,
          url: r.url,
          post_days: r.post_days || '',
          accounts: [],
        });
      }
      if (r.account_id) {
        forums.get(k).accounts.push({ id: String(r.account_id), name: r.account_name, email: r.account_email });
      }
    }
    const list = [...forums.values()];
    const days = DAY_NAMES.map((name, day) => ({
      day,
      name,
      forums: list
        .filter(f => parseDays(f.post_days).includes(day))
        .map(f => ({ forum_id: f.forum_id, forum_name: f.forum_name, url: f.url, accounts: f.accounts })),
    }));
    const unscheduled = list
      .filter(f => parseDays(f.post_days).length === 0)
      .map(f => ({ forum_id: f.forum_id, forum_name: f.forum_name }));
    res.json({ code: 200, data: { days, unscheduled } });
  } catch (err) {
    console.error('[advertising/schedule-grid] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load schedule grid' });
  }
});

router.get('/forums', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [forums] = await req.pool.execute(
      `SELECT id, name, url, notes, status, post_days FROM advertising_forum
        WHERE org_id = ? AND deleted_at IS NULL ORDER BY name`,
      [orgId]
    );
    const [members] = await req.pool.execute(
      `SELECT fa.forum_id, fa.account_id, a.name AS account_name, a.email AS account_email
         FROM advertising_forum_account fa
         JOIN advertising_account a ON a.id = fa.account_id AND a.deleted_at IS NULL
        WHERE fa.org_id = ?`,
      [orgId]
    );
    const byForum = new Map();
    for (const m of members) {
      const k = String(m.forum_id);
      if (!byForum.has(k)) byForum.set(k, []);
      byForum.get(k).push({ id: String(m.account_id), name: m.account_name, email: m.account_email });
    }
    res.json({ code: 200, data: forums.map(f => ({
      id: String(f.id), name: f.name, url: f.url, notes: f.notes, status: f.status, post_days: f.post_days || '',
      accounts: byForum.get(String(f.id)) || [],
    })) });
  } catch (err) {
    console.error('[advertising/forums list] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load forums' });
  }
});

router.post('/forums', authenticate, async (req, res) => {
  try {
    const { name, url, notes } = req.body || {};
    const bt = nonStringField(req.body || {}, ['name', 'url', 'notes']);
    if (bt) return res.status(400).json({ code: 400, message: `${bt} must be text` });
    const dayInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'post_days') ? req.body.post_days : '1,2,3,4,5,6';
    const days = validateDays(dayInput);
    if (!days.ok) return res.status(400).json({ code: 400, message: days.error });
    if (!name || !String(name).trim()) return res.status(400).json({ code: 400, message: 'Forum name is required' });
    const lenErr = lengthError({ name, url }, FORUM_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_forum (id, org_id, name, url, notes, post_days, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, req.user.orgId, String(name).trim(), url || null, notes || null, days.value]
    );
    res.json({ code: 200, data: { id } });
  } catch (err) {
    console.error('[advertising/forums create] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create forum' });
  }
});

router.put('/forums/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[exists]] = await req.pool.execute(
      `SELECT id FROM advertising_forum WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!exists) return res.status(404).json({ code: 404, message: 'Forum not found' });
    const { name, url, notes, status } = req.body || {};
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ code: 400, message: 'Forum name is required' });
    const lenErr = lengthError({ name, url }, FORUM_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const fields = [], params = [];
    if (name !== undefined) { fields.push('name = ?'); params.push(String(name).trim()); }
    if (url !== undefined) { fields.push('url = ?'); params.push(url || null); }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'post_days')) {
      const days = validateDays(req.body.post_days);
      if (!days.ok) return res.status(400).json({ code: 400, message: days.error });
      fields.push('post_days = ?');
      params.push(days.value);
    }
    if (status !== undefined) { fields.push('status = ?'); params.push(Number(status) ? 1 : 0); }
    if (!fields.length) return res.json({ code: 200, data: { id: String(req.params.id) } });
    params.push(req.params.id, orgId);
    await req.pool.execute(`UPDATE advertising_forum SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`, params);
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/forums update] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update forum' });
  }
});

router.delete('/forums/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `UPDATE advertising_forum SET deleted_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [req.params.id, orgId]
      );
      if (!result.affectedRows) { await conn.rollback(); return res.status(404).json({ code: 404, message: 'Forum not found' }); }
      await conn.execute(`DELETE FROM advertising_forum_account WHERE forum_id = ? AND org_id = ?`, [req.params.id, orgId]);
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch {} throw e; } finally { conn.release(); }
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/forums delete] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to delete forum' });
  }
});

// Set a forum's member accounts (replace the whole set). Only accounts that
// belong to this org are accepted, so a caller can't link a foreign account.
router.post('/forums/:id/members', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const forumId = req.params.id;
    const accountIds = Array.isArray(req.body && req.body.account_ids) ? req.body.account_ids.map(String) : [];
    const [[f]] = await req.pool.execute(
      `SELECT id FROM advertising_forum WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [forumId, orgId]
    );
    if (!f) return res.status(404).json({ code: 404, message: 'Forum not found' });

    // Keep only ids that are real, non-deleted accounts in THIS org.
    let valid = [];
    if (accountIds.length) {
      const ph = accountIds.map(() => '?').join(',');
      const [rows] = await req.pool.execute(
        `SELECT id FROM advertising_account WHERE org_id = ? AND deleted_at IS NULL AND id IN (${ph})`,
        [orgId, ...accountIds]
      );
      valid = rows.map(r => String(r.id));
    }

    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`DELETE FROM advertising_forum_account WHERE forum_id = ? AND org_id = ?`, [forumId, orgId]);
      for (const accId of valid) {
        await conn.execute(
          `INSERT INTO advertising_forum_account (id, org_id, forum_id, account_id, created_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [newId(), orgId, forumId, accId]
        );
      }
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch {} throw e; } finally { conn.release(); }
    const rejected = accountIds.filter(id => !valid.includes(id));
    res.json({ code: 200, data: { forum_id: String(forumId), members: valid.length, rejected } });
  } catch (err) {
    console.error('[advertising/forums members] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to set members' });
  }
});

module.exports = router;

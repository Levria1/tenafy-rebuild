const express = require('express');
const { orgToday, orgTodaySql } = require('../utils/orgTime');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { PLACEHOLDERS, applyPlaceholders, resolveUnitValues, computePostingRent, convertBold } = require('../services/advertisingTemplate');
const { DAY_NAMES, weekdayOf, postsOnDay, parseDays, validateDays, dayLabel } = require('../utils/advertisingSchedule');
const { slotLabel, findRepeatViolations, suggestReplacements, forumWeeklyLoad,
  gapIsAdvertisable, priorityOf, resolveAvailabilityWindows, sortByPriority, assignBundlesToSlots,
  manualVacancyToRow, overrideAppliesTo, leaseChangedForOverride, pickVacancyRow,
  resolvePageExpiringWindow, PAGE_WINDOW_MAX_DAYS } = require('../utils/advertisingPlan');
const { hkDate } = require('../utils/inquiryFacts');

// Snowflake id (same pattern used across the app).
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

// Column length caps (match migrations-org/015). Returns an error string when a
// field is too long, so we can 400 instead of letting MySQL 500 on truncation.
const FIELD_LIMITS = { name: 160, title: 255, webpage_link: 500, label: 255, forum_rule: 500 };
const SETTINGS_LIMITS = { photo_root: 255, partner_forward_message: 2000, inquiry_too_far_out_phrase: 2000 };
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

// Format AND calendar validity: rejects '2026-13-01' and '2026-02-30', not just
// malformed strings. Round-trips through UTC rather than local time — a zone that
// skips local midnight on a DST boundary would make a real calendar date fail a
// local-time round-trip.
function isStrictYmd(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function deriveDefaultVacancyExpiry(availableFrom) {
  const [year, month, day] = availableFrom.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 3));
  return date.toISOString().slice(0, 10);
}

function boolFlag(value) {
  return Number(value) === 1 || value === true ? 1 : 0;
}

function isMissingColumn(err, column) {
  return err && (
    err.code === 'ER_BAD_FIELD_ERROR'
    || err.errno === 1054
    || new RegExp(`Unknown column '${column}'`).test(String(err.message || ''))
  );
}

// ---------------------------------------------------------------------------
// Advertising → Vacancy
// Units that need advertising, in two categories:
//   1. VACANT NOW  — active unit with NO CURRENT LEASE. The human-facing page
//      shows every such unit. The scheduler advertises it only when there is no
//      next lease or the free gap meets the configured minimum.
//   2. EXPIRING    — a current lease is ending within its renewal-intent lead
//      window and no replacement is lined up.
//
// Units whose name/property contains "test" are excluded (placeholder data).
//
// Keyed off DATE-COMPUTED lease status (start_date/end_date/CURDATE()), NOT the
// stored `leasing.status` column — that column is not maintained on expiry.
//
// The human-facing page keeps its flat 60-day window. The scheduler queries the
// wider configured lead window, filters each row through priorityOf(), and sorts
// by priority tier before urgency.
// ---------------------------------------------------------------------------

const EXPIRING_WINDOW = 60;   // days before lease end, all intents
const INTENT = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };

const tenantNameSql = (a) => `CASE WHEN ${a}.type = 1 THEN ${a}.company_name
       ELSE TRIM(CONCAT(COALESCE(${a}.first_name,''), ' ', COALESCE(${a}.last_name,''))) END`;
const TENANT_NAME_SQL = tenantNameSql('t');

// The unit's NEXT upcoming lease (earliest start > today) → next move-in date +
// tenant. Used by the "vacant now" query so the Leasing → Vacancy page can show a
// unit that is empty TODAY even when someone is moving in later (for viewings).
// Functions, not constants: each embeds today's date, and a module-level constant
// would capture the day the process booted and hold it until the next restart.
function nextMoveInJoin() {
  return `
       LEFT JOIN leasing nl ON nl.id = (
         SELECT lm.id FROM leasing lm
          WHERE lm.unit_id = u.id AND lm.deleted_at IS NULL AND lm.start_date > ${orgTodaySql()}
          ORDER BY lm.start_date ASC LIMIT 1)
       LEFT JOIN tenant nt ON nt.id = nl.tenant_id`;
}
function nextMoveInCols() {
  return `
          DATE_FORMAT(nl.start_date, '%Y-%m-%d') AS next_move_in_date,
          DATEDIFF(nl.start_date, ${orgTodaySql()}) AS days_to_move_in,
          nl.tenant_id AS next_tenant_id, ${tenantNameSql('nt')} AS next_tenant_name`;
}

// Sub-conditions reused for the "vacant now" query (correlated on u.id).
function noCurrentLease() {
  return `NOT EXISTS (
  SELECT 1 FROM leasing lc
   WHERE lc.unit_id = u.id AND lc.deleted_at IS NULL
     AND lc.start_date <= ${orgTodaySql()} AND (lc.end_date IS NULL OR lc.end_date >= ${orgTodaySql()}))`;
}

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
//   - VACANT: the page includes every unit empty today. The scheduler filters a
//     booked next move-in through the minimum-gap setting; `days_to_move_in`
//     carries the length of that window and `gap_ok` records the decision.
async function computeVacancies(pool, orgId, { page = false, minGapDays, settings: suppliedSettings, audience = 'advertising', throughDate = null } = {}) {
    const settings = suppliedSettings || (page ? null : await loadSettings(pool, orgId));
    const availabilityWindows = resolveAvailabilityWindows(settings || {}, audience);
    // Precedence: explicit argument > audience override > advertising value.
    const effectiveMinGapDays = page ? 40 : (minGapDays ?? availabilityWindows.min_gap_days);
    const expiringWindow = page
      ? resolvePageExpiringWindow(throughDate, orgToday(), EXPIRING_WINDOW)
      : Math.max(availabilityWindows.lead_days_nr, availabilityWindows.lead_days_other);
    // 1. EXPIRING — the unit's LATEST lease (current OR a future one) ends within
    //    the window and nothing follows it. We intentionally do NOT require the
    //    lease to have started: a unit re-let with a SHORT upcoming lease (e.g.
    //    current ends soon, a brief future lease runs a couple weeks, then nothing)
    //    genuinely goes vacant at that future end — the NOT EXISTS below already
    //    isolates the last lease, so dropping the start_date filter surfaces it.
    //    A unit re-let with a LONG future lease stays hidden (its end is >window).
    const [expiring] = await pool.execute(
      `SELECT
          l.id AS lease_id, l.contract_type,
          -- Price is what the invoice generator bills; an advertised rent that
          -- disagrees is a promise we do not keep. Fall back to amount only
          -- when price is missing or 0 (legacy rows).
          COALESCE(NULLIF(l.price, 0), l.amount) AS rent, l.deposit, l.notice_period_days,
          -- Public feed needs the schedule to know whether this figure is monthly.
          l.invoicing,
          DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
          DATEDIFF(l.end_date, ${orgTodaySql()}) AS days_left,
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.rent_price_min, u.rent_price_max, u.listing_url AS listing_url,
          at.id AS template_id, at.name AS template_name,
          p.id AS property_id, p.display_name AS property_name, p.street_address, p.district, p.city,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ?
         AND l.deleted_at IS NULL
         AND u.active_status = 1
         ${page ? `AND l.start_date <= ${orgTodaySql()}` : ''}
         AND l.end_date IS NOT NULL
         AND l.end_date >= ${orgTodaySql()}
         AND DATEDIFF(l.end_date, ${orgTodaySql()}) <= ${expiringWindow}
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

    // 2. VACANT NOW — active unit with no current lease. Pull the
    // most-recent ended lease (for "vacant since" + last tenant/rent reference);
    // NULL for a never-leased unit.
    const [vacant] = await pool.execute(
      `SELECT
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.rent_price_min, u.rent_price_max, u.listing_url AS listing_url,
          at.id AS template_id, at.name AS template_name,
          p.id AS property_id, p.display_name AS property_name, p.street_address, p.district, p.city,
          ll.id AS last_lease_id,
          DATE_FORMAT(ll.end_date, '%Y-%m-%d') AS vacant_since,
          DATEDIFF(${orgTodaySql()}, ll.end_date) AS days_vacant,
          -- Price is what the invoice generator bills; an advertised rent that
          -- disagrees is a promise we do not keep. Fall back to amount only
          -- when price is missing or 0 (legacy rows).
          COALESCE(NULLIF(ll.price, 0), ll.amount) AS rent, ll.deposit, ll.contract_type,
          ll.invoicing,
          t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name,${nextMoveInCols()}
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
       LEFT JOIN leasing ll ON ll.id = (
          SELECT le.id FROM leasing le
           WHERE le.unit_id = u.id AND le.deleted_at IS NULL
             AND le.end_date IS NOT NULL AND le.end_date < ${orgTodaySql()}
           ORDER BY le.end_date DESC, le.id DESC LIMIT 1)
       LEFT JOIN tenant t ON t.id = ll.tenant_id${nextMoveInJoin()}
       WHERE p.org_id = ?
         AND u.active_status = 1
         AND ${NOT_TEST}
         AND ${noCurrentLease()}`,
      [orgId]
    );

    const [manualOverrides] = await pool.execute(
      `SELECT
          m.id, m.lease_id, cl.id AS current_lease_id, DATE_FORMAT(m.available_from, '%Y-%m-%d') AS available_from,
          DATE_FORMAT(m.expires_on, '%Y-%m-%d') AS expires_on,
          m.advertising_enabled, m.inquiry_enabled, m.reason,
          DATE_FORMAT(${orgTodaySql()}, '%Y-%m-%d') AS today,
          u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
          u.rent_price_min, u.rent_price_max, u.rent_price_min AS rent, u.listing_url AS listing_url,
          at.id AS template_id, at.name AS template_name,
          p.id AS property_id, p.display_name AS property_name, p.street_address, p.district, p.city
       FROM manual_vacancy_override m
       JOIN unit u ON m.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
       LEFT JOIN leasing cl ON cl.id = (
         SELECT l.id FROM leasing l
          WHERE l.unit_id = m.unit_id
            AND l.deleted_at IS NULL
            AND l.start_date <= ${orgTodaySql()}
            AND (l.end_date IS NULL OR l.end_date >= ${orgTodaySql()})
          ORDER BY l.start_date DESC, l.id DESC LIMIT 1)
       WHERE m.org_id = ?
         AND p.org_id = ?
         AND m.status = 1
         AND m.expires_on >= ${orgTodaySql()}
         AND u.active_status = 1
         AND ${NOT_TEST}
       ORDER BY m.created_at DESC`,
      [orgId, orgId]
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

    const expiringRows = expiring.map(r => {
      const priority = priorityOf({
        is_vacant: false,
        contract_type: r.contract_type,
        days_left: r.days_left != null ? Number(r.days_left) : null,
      }, availabilityWindows);
      return ({
      status: 'expiring',
      lease_id: String(r.lease_id),
      contract_type: r.contract_type,
      notice_period_days: r.notice_period_days != null ? Number(r.notice_period_days) : null,
      intent: INTENT[r.contract_type] || 'Unset',
      days_left: r.days_left != null ? Number(r.days_left) : null,   // days until vacant (positive)
      end_date: r.end_date,
      vacant_since: null,
      rent: r.rent != null ? Number(r.rent) : null,
      invoicing: r.invoicing ?? null,
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
      district: r.district, city: r.city,
      tenant_id: r.tenant_id ? String(r.tenant_id) : null,
      tenant_name: (r.tenant_name || '').trim() || '(no tenant)',
      moveout_notes: moveoutByLease[String(r.lease_id)]?.moveout_notes || null,
      moved_out_early: !!moveoutByLease[String(r.lease_id)]?.moved_out_early,
      // Expiring rows are (page) NOT re-let, so there is no upcoming move-in.
      next_move_in_date: null, days_to_move_in: null, next_tenant_id: null, next_tenant_name: null,
      tier: priority.tier,
      priority_reason: priority.reason,
    });
    }).filter(row => page || priorityOf({
      is_vacant: false, contract_type: row.contract_type, days_left: row.days_left,
    }, availabilityWindows).advertisable);

    const vacantRows = vacant.map(r => {
      // days_vacant computed by the DB (DATEDIFF) so it agrees with CURDATE()/
      // end_date and can't drift a day from server-vs-DB timezone.
      const daysVacant = r.days_vacant != null ? Number(r.days_vacant) : null;
      const daysToMoveIn = r.days_to_move_in != null ? Number(r.days_to_move_in) : null;
      const gapOk = gapIsAdvertisable(daysToMoveIn, effectiveMinGapDays);
      const priority = priorityOf({ is_vacant: true, gap_ok: gapOk, days_left: daysVacant != null ? -daysVacant : null }, availabilityWindows);
      return {
        status: 'vacant',
        lease_id: null,
        contract_type: r.contract_type,
        notice_period_days: null,   // no current lease → no notice period
        intent: INTENT[r.contract_type] || 'Unset',
        // Negative = already vacant N days; null = never leased.
        days_left: daysVacant != null ? -daysVacant : null,
        days_vacant: daysVacant,
        end_date: null,
        vacant_since: r.vacant_since,   // null when never leased
        rent: r.rent != null ? Number(r.rent) : null,      // last lease rent (reference)
        invoicing: r.invoicing ?? null,
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
        district: r.district, city: r.city,
        tenant_id: r.tenant_id ? String(r.tenant_id) : null,   // last tenant
        tenant_name: (r.tenant_name || '').trim() || null,
        moveout_notes: moveoutByLease[String(r.last_lease_id)]?.moveout_notes || null,
        moved_out_early: !!moveoutByLease[String(r.last_lease_id)]?.moved_out_early,
        // Next upcoming lease (a booked move-in even though it's empty today).
        next_move_in_date: r.next_move_in_date || null,
        days_to_move_in: daysToMoveIn,
        gap_ok: gapOk,
        tier: priority.tier,
        priority_reason: priority.reason,
        next_tenant_id: r.next_tenant_id ? String(r.next_tenant_id) : null,
        next_tenant_name: (r.next_tenant_name || '').trim() || null,
      };
    }).filter(row => page || row.gap_ok);

    const selectedRealRows = new Map([...vacantRows, ...expiringRows].map(row => [String(row.unit_id), row]));
    const manualRows = [];
    for (const override of manualOverrides) {
      const leaseChanged = leaseChangedForOverride(override);
      if (!overrideAppliesTo(override, audience, { page })) continue;
      const manualRow = manualVacancyToRow({ ...override, lease_changed: leaseChanged }, override, override.today);
      const unitKey = String(manualRow.unit_id);
      const realRow = selectedRealRows.get(unitKey);
      // Stale overrides describe a conversation about a specific tenancy. If the
      // lease was renewed, replaced or re-dated, that conversation may no longer
      // apply, and the operator must re-confirm rather than keep offering it.
      if (leaseChanged) {
        if (page) {
          selectedRealRows.delete(unitKey);
          manualRows.push(manualRow);
        }
        continue;
      }
      const winner = pickVacancyRow(manualRow, realRow);
      if (winner === manualRow) {
        selectedRealRows.delete(unitKey);
        manualRows.push(manualRow);
      }
    }
    const realRows = [...selectedRealRows.values()];
    const selectedVacantRows = realRows.filter(row => row.status === 'vacant');
    const selectedExpiringRows = realRows.filter(row => row.status === 'expiring');

    // Urgency sort: longest-vacant (most negative) → soonest-expiring (small
    // positive) → later-expiring → never-leased (no date) last.
    const NEVER_LEASED = Number.POSITIVE_INFINITY;
    const sortKey = (x) => (x.days_left == null ? NEVER_LEASED : x.days_left);
    const urgencySorted = [...realRows, ...manualRows].sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return (a.property_name || '').localeCompare(b.property_name || '');
    });
    const vacancies = page ? urgencySorted : sortByPriority([...realRows, ...manualRows]);

    return { vacancies, vacant_count: selectedVacantRows.length, expiring_count: selectedExpiringRows.length, manual_count: manualRows.length, expiring_window: expiringWindow };
}

router.get('/vacancy-override', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const leaseId = req.query.lease_id != null && String(req.query.lease_id).trim() !== ''
      ? String(req.query.lease_id).trim()
      : null;
    const params = [orgId, orgId];
    const leaseFilter = leaseId ? ' AND m.lease_id = ?' : '';
    if (leaseId) params.push(leaseId);
    const [rows] = await req.pool.execute(
      `SELECT
          m.id, m.unit_id, m.lease_id, DATE_FORMAT(m.available_from, '%Y-%m-%d') AS available_from,
          DATE_FORMAT(m.expires_on, '%Y-%m-%d') AS expires_on,
          m.advertising_enabled, m.inquiry_enabled, m.reason, m.status,
          m.created_by, m.created_at, m.updated_at,
          u.name AS unit_name,
          p.id AS property_id, p.display_name AS property_name
       FROM manual_vacancy_override m
       JOIN unit u ON m.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE m.org_id = ?
         AND p.org_id = ?
         AND m.status = 1
         AND m.expires_on >= ${orgTodaySql()}
         ${leaseFilter}
       ORDER BY m.created_at DESC
       ${leaseId ? 'LIMIT 1' : ''}`,
      params
    );
    res.json({
      code: 200,
      data: rows.map(r => ({
        id: String(r.id),
        unit_id: String(r.unit_id),
        lease_id: r.lease_id == null ? null : String(r.lease_id),
        unit_name: r.unit_name,
        property_id: String(r.property_id),
        property_name: r.property_name,
        available_from: r.available_from,
        expires_on: r.expires_on,
        advertising_enabled: Number(r.advertising_enabled) === 1,
        inquiry_enabled: Number(r.inquiry_enabled) === 1,
        reason: r.reason || null,
        status: Number(r.status),
        created_by: r.created_by == null ? null : String(r.created_by),
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('[advertising/vacancy-override list] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load vacancy overrides' });
  }
});

router.post('/vacancy-override', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { unit_id, lease_id, available_from, expires_on, advertising_enabled, inquiry_enabled, reason } = req.body || {};
    const requestedLeaseId = lease_id != null && String(lease_id).trim() !== '' ? String(lease_id).trim() : null;
    const requestedUnitId = unit_id != null && String(unit_id).trim() !== '' ? String(unit_id).trim() : null;
    if (!requestedLeaseId && !requestedUnitId) return res.status(400).json({ code: 400, message: 'unit_id or lease_id is required' });
    if (!isStrictYmd(available_from)) return res.status(400).json({ code: 400, message: 'available_from is required in YYYY-MM-DD format' });
    const hasExplicitExpiry = expires_on != null && String(expires_on).trim() !== '';
    if (hasExplicitExpiry && !isStrictYmd(String(expires_on))) return res.status(400).json({ code: 400, message: 'expires_on must be in YYYY-MM-DD format' });
    // Without an explicit expiry, the requested move-out date is the availability
    // date. If the tenant has not left by three days after that, the claim is
    // stale; the grace covers late recording of the real move-out.
    const effectiveExpiresOn = hasExplicitExpiry ? String(expires_on) : deriveDefaultVacancyExpiry(available_from);
    const today = hkDate(new Date().toISOString());
    if (effectiveExpiresOn < today) return res.status(400).json({ code: 400, message: 'expires_on must be today or later' });
    if (effectiveExpiresOn < available_from) return res.status(400).json({ code: 400, message: 'expires_on must be on or after available_from' });
    const advertisingEnabled = boolFlag(advertising_enabled);
    const inquiryEnabled = boolFlag(inquiry_enabled);
    const normalizedReason = reason == null || String(reason).trim() === '' ? null : String(reason).trim();
    if (normalizedReason && normalizedReason.length > 255) {
      return res.status(400).json({ code: 400, message: 'reason must be 255 characters or fewer' });
    }
    let unitId = requestedUnitId;
    let leaseId = null;
    if (requestedLeaseId) {
      // If both ids are sent, lease_id wins: the request is about that specific
      // tenancy, and the unit must be derived from the org-scoped lease lookup.
      const [[lease]] = await req.pool.execute(
        `SELECT l.id, l.unit_id
           FROM leasing l
           JOIN unit u ON l.unit_id = u.id
           JOIN property p ON u.property_id = p.id
          WHERE l.id = ?
            AND p.org_id = ?
            AND l.deleted_at IS NULL
          LIMIT 1`,
        [requestedLeaseId, orgId]
      );
      if (!lease) return res.status(404).json({ code: 404, message: 'Lease not found' });
      unitId = lease.unit_id;
      leaseId = lease.id;
    } else {
      const [[unit]] = await req.pool.execute(
        `SELECT u.id
           FROM unit u
           JOIN property p ON u.property_id = p.id
          WHERE u.id = ? AND p.org_id = ?
          LIMIT 1`,
        [unitId, orgId]
      );
      if (!unit) return res.status(404).json({ code: 404, message: 'Unit not found' });
      const [[activeLease]] = await req.pool.execute(
        `SELECT id FROM leasing
          WHERE unit_id = ?
            AND deleted_at IS NULL
            AND start_date <= ${orgTodaySql()}
            AND (end_date IS NULL OR end_date >= ${orgTodaySql()})
          ORDER BY start_date DESC, id DESC LIMIT 1`,
        [unitId]
      );
      leaseId = activeLease ? activeLease.id : null;
    }

    const [[existing]] = await req.pool.execute(
      `SELECT id FROM manual_vacancy_override
        WHERE org_id = ? AND unit_id = ? AND status = 1
        LIMIT 1`,
      [orgId, unitId]
    );
    if (existing) {
      await req.pool.execute(
        `UPDATE manual_vacancy_override
            SET available_from = ?, expires_on = ?, advertising_enabled = ?, inquiry_enabled = ?,
                lease_id = ?, reason = ?, updated_at = NOW()
          WHERE id = ? AND org_id = ? AND status = 1`,
        [available_from, effectiveExpiresOn, advertisingEnabled, inquiryEnabled, leaseId, normalizedReason, existing.id, orgId]
      );
      return res.json({ code: 200, data: { id: String(existing.id), action: 'updated' } });
    }

    const id = newId();
    await req.pool.execute(
      `INSERT INTO manual_vacancy_override
         (id, org_id, unit_id, lease_id, available_from, expires_on, advertising_enabled, inquiry_enabled, reason, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
      [id, orgId, unitId, leaseId, available_from, effectiveExpiresOn, advertisingEnabled, inquiryEnabled, normalizedReason, req.user.id || null]
    );
    res.json({ code: 200, data: { id, action: 'created' } });
  } catch (err) {
    console.error('[advertising/vacancy-override save] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to save vacancy override' });
  }
});

router.delete('/vacancy-override/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [result] = await req.pool.execute(
      `UPDATE manual_vacancy_override
          SET status = 0, cleared_at = NOW(), cleared_by = ?, updated_at = NOW()
        WHERE id = ? AND org_id = ? AND status = 1`,
      [req.user.id || null, req.params.id, orgId]
    );
    if (!result.affectedRows) return res.status(404).json({ code: 404, message: 'Vacancy override not found' });
    res.json({ code: 200, data: { id: String(req.params.id), status: 0 } });
  } catch (err) {
    console.error('[advertising/vacancy-override clear] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to clear vacancy override' });
  }
});

router.get('/vacancies', authenticate, async (req, res) => {
  try {
    const requestedThrough = typeof req.query.through === 'string' ? req.query.through : null;
    const throughDate = isStrictYmd(requestedThrough) ? requestedThrough : null;
    const { vacancies, vacant_count, expiring_count, manual_count, expiring_window } = await computeVacancies(req.pool, req.user.orgId, { page: true, throughDate });
    res.json({
      code: 200,
      data: {
        as_of: orgToday(),
        lead_days: expiring_window,
        default_lead_days: EXPIRING_WINDOW,
        // How far `through` can reach before it is clamped. The page uses this to stop
        // the operator picking a range it would silently only half-answer.
        max_lead_days: PAGE_WINDOW_MAX_DAYS,
        through: throughDate,
        count: vacancies.length,
        vacant_count,
        expiring_count,
        manual_count,
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
      tier: v.tier, intent: v.intent, priority_reason: v.priority_reason,
      rent_price_min: v.rent_price_min, rent_price_max: v.rent_price_max,
    });
  }
  const bundles = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.units.length; i += MAX_BUNDLE_UNITS) {
      const units = g.units.slice(i, i + MAX_BUNDLE_UNITS);
      const leadUnit = units.reduce((best, unit) => Number(unit.tier) < Number(best.tier) ? unit : best, units[0]);
      bundles.push({
        property_id: g.property_id, property_name: g.property_name,
        template_id: g.template_id, template_name: g.template_name,
        tier: leadUnit.tier, intent: leadUnit.intent,
        units,
      });
    }
  }
  const urgency = (b) => Math.min(...b.units.map(u => (u.days_left == null ? Number.POSITIVE_INFINITY : u.days_left)));
  const ordered = sortByPriority(bundles.map((item, index) => ({
    tier: item.tier,
    days_left: urgency(item),
    property_name: item.property_name,
    index,
  })));
  return ordered.map(item => bundles[item.index]);
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
        as_of: orgToday(),
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
// The daily instructions the PC agent calls: each vacancy bundle rendered
// (shared body + a per-unit line for each unit) and assigned positionally to the
// operator's slot schedule for that weekday. advertising_post_log remains the
// audit trail for posted/skipped actions, but forum choice is schedule-driven.
// ===========================================================================

// No ROTATION_WINDOW_DAYS any more. Forum choice used to avoid reusing a forum for
// a property within 7 days, read out of advertising_post_log; the slot schedule now
// decides it outright, so that constant was left unreferenced and only misled
// readers into thinking rotation was still live. `mark` still writes post_log as an
// audit trail, but nothing reads it back.
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
  // Kept aligned with bundle.units (null where the unit vanished), so callers can
  // report the price this post ACTUALLY advertises rather than re-deriving it and
  // risking a badge that disagrees with the ad text.
  const unitValues = [];
  for (const u of bundle.units) {
    const values = await resolveUnitValues(pool, orgId, u.unit_id, template);
    unitValues.push(values || null);
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
           webpage_link: template.webpage_link || null, footer: footer || null, text,
           unit_values: unitValues };
}

// The rent this post advertises, per unit. Two sources, in order:
//   1. the rendered %PostingRentAmount% — the exact number in the ad text, which
//      also covers units whose range is blank and fall back to the last lease;
//   2. computePostingRent from the vacancy row — used when there is no template to
//      render (needs_template / no_slot rows), so the operator still sees a price.
// `tier` is the step-down band (high/mid/low/discount): it is how the operator sees
// at a glance that a unit is being advertised at a discount.
function postingPrices(bundle, rendered) {
  return bundle.units.map((u, i) => {
    const step = computePostingRent(u.rent_price_min, u.rent_price_max, u.days_left);
    const values = rendered && rendered.unit_values ? rendered.unit_values[i] : null;
    let amount = step ? step.amount : null;
    if (values) {
      const n = Number(String(values['%PostingRentAmount%'] || '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n) && n > 0) amount = n;
    }
    // Field names match the /scheduler slot payload so the frontend reads one shape.
    return {
      unit_id: String(u.unit_id),
      unit_name: u.unit_name,
      posting_rent: amount != null ? Number(amount) : null,
      posting_tier: step ? step.tier : null,
      rent_price_min: u.rent_price_min != null ? Number(u.rent_price_min) : null,
      rent_price_max: u.rent_price_max != null ? Number(u.rent_price_max) : null,
    };
  });
}

// Org-wide advertising settings (shared footer + photo root).
async function findBeyondHorizonNrVacancies(pool, orgId, { requestDate, maxGapDays, propertyId = null, limit = 200 } = {}) {
  const configuredGap = Number(maxGapDays);
  const gapLimit = Number.isFinite(configuredGap) ? Math.trunc(configuredGap) : 10;
  const cappedLimit = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 200)));
  const propertyClause = propertyId ? 'AND p.id = ?' : '';
  const params = [orgId, requestDate, gapLimit];
  if (propertyId) params.push(propertyId);
  const [rows] = await pool.execute(
    `SELECT
        l.id AS lease_id, l.contract_type,
        COALESCE(NULLIF(l.price, 0), l.amount) AS rent, l.deposit, l.notice_period_days,
        l.invoicing,
        DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
        DATEDIFF(l.end_date, ${orgTodaySql()}) AS days_left,
        u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths, u.size,
        u.rent_price_min, u.rent_price_max, u.listing_url AS listing_url,
        at.id AS template_id, at.name AS template_name,
        p.id AS property_id, p.display_name AS property_name, p.street_address, p.district, p.city,
        t.id AS tenant_id, ${TENANT_NAME_SQL} AS tenant_name,
        NULL AS next_move_in_date,
        NULL AS days_to_move_in,
        NULL AS next_tenant_id,
        NULL AS next_tenant_name
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     LEFT JOIN advertising_template at ON at.id = u.advertising_template_id AND at.deleted_at IS NULL
     LEFT JOIN tenant t ON l.tenant_id = t.id
     WHERE p.org_id = ?
       AND l.deleted_at IS NULL
       AND u.active_status = 1
       AND l.contract_type = 3
       AND l.end_date IS NOT NULL
       AND l.end_date >= ${orgTodaySql()}
       AND DATEDIFF(?, l.end_date) BETWEEN 0 AND ?
       ${propertyClause}
       AND ${NOT_TEST}
       AND NOT EXISTS (
         SELECT 1 FROM leasing l2
          WHERE l2.unit_id = l.unit_id AND l2.deleted_at IS NULL
            AND l2.id <> l.id
            AND (l2.end_date IS NULL
                 OR l2.end_date > l.end_date
                 OR (l2.end_date = l.end_date AND l2.id > l.id)))
     ORDER BY l.end_date ASC, p.display_name ASC, u.name ASC
     LIMIT ${cappedLimit}`,
    params
  );

  return rows.map(r => ({
    status: 'expiring',
    lease_id: String(r.lease_id),
    contract_type: r.contract_type,
    notice_period_days: r.notice_period_days != null ? Number(r.notice_period_days) : null,
    intent: INTENT[r.contract_type] || 'Unset',
    days_left: r.days_left != null ? Number(r.days_left) : null,
    end_date: r.end_date,
    vacant_since: null,
    rent: r.rent != null ? Number(r.rent) : null,
    invoicing: r.invoicing ?? null,
    deposit: r.deposit != null ? Number(r.deposit) : null,
    unit_id: String(r.unit_id),
    unit_name: r.unit_name,
    unit_type: r.unit_type,
    beds: r.beds != null ? Number(r.beds) : null,
    baths: r.baths != null ? Number(r.baths) : null,
    size: r.size != null ? Number(r.size) : null,
    rent_price_min: r.rent_price_min != null ? Number(r.rent_price_min) : null,
    rent_price_max: r.rent_price_max != null ? Number(r.rent_price_max) : null,
    template_id: r.template_id ? String(r.template_id) : null,
    template_name: r.template_name || null,
    property_id: r.property_id == null ? null : String(r.property_id),
    property_name: r.property_name,
    street_address: r.street_address,
    district: r.district,
    city: r.city,
    tenant_id: r.tenant_id == null ? null : String(r.tenant_id),
    tenant_name: r.tenant_name,
    moveout_notes: null,
    moved_out_early: false,
    next_move_in_date: null,
    days_to_move_in: null,
    next_tenant_id: null,
    next_tenant_name: null,
    tier: 2,
    priority_reason: 'nr_booking_horizon',
    source: 'lease',
  }));
}

async function loadSettings(pool, orgId) {
  const defaults = {
    footer: null,
    photo_root: PHOTO_ROOT,
    partner_forward_message: null,
    min_gap_days: 40,
    max_gap_days: 10,
    hard_max_gap_days: 20,
    lead_days_nr: 60,
    lead_days_other: 45,
    inquiry_min_gap_days: 40,
    inquiry_lead_days_nr: 60,
    inquiry_lead_days_other: 45,
    inquiry_booking_horizon_days: 60,
    inquiry_too_far_out_phrase: null,
    inquiry_gap_band_1m_days: 3,
    inquiry_gap_band_2m_days: 6,
    inquiry_gap_band_3m_plus_days: 10,
    search_gap_band_1m_days: 3,
    search_gap_band_2m_days: 6,
    search_gap_band_3m_plus_days: 10,
  };
  const numberOrDefault = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  try {
    const [[row]] = await pool.execute(
      `SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days, lead_days_nr, lead_days_other,
              inquiry_min_gap_days, inquiry_lead_days_nr, inquiry_lead_days_other,
              inquiry_booking_horizon_days, inquiry_too_far_out_phrase,
              inquiry_gap_band_1m_days, inquiry_gap_band_2m_days, inquiry_gap_band_3m_plus_days,
              search_gap_band_1m_days, search_gap_band_2m_days, search_gap_band_3m_plus_days
         FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
    return {
      footer: row?.footer || null,
      photo_root: row?.photo_root || PHOTO_ROOT,
      // Outward-facing partner-agency text is opt-in only. NULL means unauthored.
      partner_forward_message: row?.partner_forward_message ?? null,
      min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
      max_gap_days: Number.isFinite(Number(row?.max_gap_days)) ? Number(row.max_gap_days) : 10,
      hard_max_gap_days: Number.isFinite(Number(row?.hard_max_gap_days)) ? Number(row.hard_max_gap_days) : 20,
      lead_days_nr: Number.isFinite(Number(row?.lead_days_nr)) ? Number(row.lead_days_nr) : 60,
      lead_days_other: Number.isFinite(Number(row?.lead_days_other)) ? Number(row.lead_days_other) : 45,
      inquiry_min_gap_days: numberOrDefault(row?.inquiry_min_gap_days, 40),
      inquiry_lead_days_nr: numberOrDefault(row?.inquiry_lead_days_nr, 60),
      inquiry_lead_days_other: numberOrDefault(row?.inquiry_lead_days_other, 45),
      inquiry_booking_horizon_days: numberOrDefault(row?.inquiry_booking_horizon_days, 60),
      inquiry_too_far_out_phrase: row?.inquiry_too_far_out_phrase ?? null,
      inquiry_gap_band_1m_days: numberOrDefault(row?.inquiry_gap_band_1m_days, 3),
      inquiry_gap_band_2m_days: numberOrDefault(row?.inquiry_gap_band_2m_days, 6),
      inquiry_gap_band_3m_plus_days: numberOrDefault(row?.inquiry_gap_band_3m_plus_days, 10),
      search_gap_band_1m_days: numberOrDefault(row?.search_gap_band_1m_days, 3),
      search_gap_band_2m_days: numberOrDefault(row?.search_gap_band_2m_days, 6),
      search_gap_band_3m_plus_days: numberOrDefault(row?.search_gap_band_3m_plus_days, 10),
    };
  } catch (err) {
    try {
      const [[row]] = await pool.execute(
        `SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days, lead_days_nr, lead_days_other,
                inquiry_min_gap_days, inquiry_lead_days_nr, inquiry_lead_days_other,
                inquiry_booking_horizon_days, inquiry_too_far_out_phrase,
                inquiry_gap_band_1m_days, inquiry_gap_band_2m_days, inquiry_gap_band_3m_plus_days
           FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
      return {
        ...defaults,
        footer: row?.footer || null,
        photo_root: row?.photo_root || PHOTO_ROOT,
        // Outward-facing partner-agency text is opt-in only. NULL means unauthored.
        partner_forward_message: row?.partner_forward_message ?? null,
        min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
        max_gap_days: Number.isFinite(Number(row?.max_gap_days)) ? Number(row.max_gap_days) : 10,
        hard_max_gap_days: Number.isFinite(Number(row?.hard_max_gap_days)) ? Number(row.hard_max_gap_days) : 20,
        lead_days_nr: Number.isFinite(Number(row?.lead_days_nr)) ? Number(row.lead_days_nr) : 60,
        lead_days_other: Number.isFinite(Number(row?.lead_days_other)) ? Number(row.lead_days_other) : 45,
        inquiry_min_gap_days: numberOrDefault(row?.inquiry_min_gap_days, 40),
        inquiry_lead_days_nr: numberOrDefault(row?.inquiry_lead_days_nr, 60),
        inquiry_lead_days_other: numberOrDefault(row?.inquiry_lead_days_other, 45),
        inquiry_booking_horizon_days: numberOrDefault(row?.inquiry_booking_horizon_days, 60),
        inquiry_too_far_out_phrase: row?.inquiry_too_far_out_phrase ?? null,
        inquiry_gap_band_1m_days: numberOrDefault(row?.inquiry_gap_band_1m_days, 3),
        inquiry_gap_band_2m_days: numberOrDefault(row?.inquiry_gap_band_2m_days, 6),
        inquiry_gap_band_3m_plus_days: numberOrDefault(row?.inquiry_gap_band_3m_plus_days, 10),
      };
    } catch {
    try {
      const [[row]] = await pool.execute(
        `SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days, lead_days_nr, lead_days_other,
                inquiry_min_gap_days, inquiry_lead_days_nr, inquiry_lead_days_other,
                inquiry_booking_horizon_days, inquiry_too_far_out_phrase
           FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
      return {
        ...defaults,
        footer: row?.footer || null,
        photo_root: row?.photo_root || PHOTO_ROOT,
        // Outward-facing partner-agency text is opt-in only. NULL means unauthored.
        partner_forward_message: row?.partner_forward_message ?? null,
        min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
        max_gap_days: Number.isFinite(Number(row?.max_gap_days)) ? Number(row.max_gap_days) : 10,
        hard_max_gap_days: Number.isFinite(Number(row?.hard_max_gap_days)) ? Number(row.hard_max_gap_days) : 20,
        lead_days_nr: Number.isFinite(Number(row?.lead_days_nr)) ? Number(row.lead_days_nr) : 60,
        lead_days_other: Number.isFinite(Number(row?.lead_days_other)) ? Number(row.lead_days_other) : 45,
        inquiry_min_gap_days: numberOrDefault(row?.inquiry_min_gap_days, 40),
        inquiry_lead_days_nr: numberOrDefault(row?.inquiry_lead_days_nr, 60),
        inquiry_lead_days_other: numberOrDefault(row?.inquiry_lead_days_other, 45),
        inquiry_booking_horizon_days: numberOrDefault(row?.inquiry_booking_horizon_days, 60),
        inquiry_too_far_out_phrase: row?.inquiry_too_far_out_phrase ?? null,
      };
    } catch {
    try {
      const [[row]] = await pool.execute(
        `SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days, lead_days_nr, lead_days_other,
                inquiry_min_gap_days, inquiry_lead_days_nr, inquiry_lead_days_other
           FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
      return {
        ...defaults,
        footer: row?.footer || null,
        photo_root: row?.photo_root || PHOTO_ROOT,
        // Outward-facing partner-agency text is opt-in only. NULL means unauthored.
        partner_forward_message: row?.partner_forward_message ?? null,
        min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
        max_gap_days: Number.isFinite(Number(row?.max_gap_days)) ? Number(row.max_gap_days) : 10,
        hard_max_gap_days: Number.isFinite(Number(row?.hard_max_gap_days)) ? Number(row.hard_max_gap_days) : 20,
        lead_days_nr: Number.isFinite(Number(row?.lead_days_nr)) ? Number(row.lead_days_nr) : 60,
        lead_days_other: Number.isFinite(Number(row?.lead_days_other)) ? Number(row.lead_days_other) : 45,
        inquiry_min_gap_days: numberOrDefault(row?.inquiry_min_gap_days, 40),
        inquiry_lead_days_nr: numberOrDefault(row?.inquiry_lead_days_nr, 60),
        inquiry_lead_days_other: numberOrDefault(row?.inquiry_lead_days_other, 45),
      };
    } catch {
      try {
        const [[row]] = await pool.execute(
          `SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days, lead_days_nr, lead_days_other
             FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
        return {
          ...defaults,
          footer: row?.footer || null,
          photo_root: row?.photo_root || PHOTO_ROOT,
          // Outward-facing partner-agency text is opt-in only. NULL means unauthored.
          partner_forward_message: row?.partner_forward_message ?? null,
          min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
          max_gap_days: Number.isFinite(Number(row?.max_gap_days)) ? Number(row.max_gap_days) : 10,
          hard_max_gap_days: Number.isFinite(Number(row?.hard_max_gap_days)) ? Number(row.hard_max_gap_days) : 20,
          lead_days_nr: Number.isFinite(Number(row?.lead_days_nr)) ? Number(row.lead_days_nr) : 60,
          lead_days_other: Number.isFinite(Number(row?.lead_days_other)) ? Number(row.lead_days_other) : 45,
        };
      } catch {
        try {
          const [[row]] = await pool.execute(
            `SELECT footer, photo_root, min_gap_days, max_gap_days, lead_days_nr, lead_days_other FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
          return {
            ...defaults, footer: row?.footer || null, photo_root: row?.photo_root || PHOTO_ROOT,
            min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
            max_gap_days: Number.isFinite(Number(row?.max_gap_days)) ? Number(row.max_gap_days) : 10,
            lead_days_nr: Number.isFinite(Number(row?.lead_days_nr)) ? Number(row.lead_days_nr) : 60,
            lead_days_other: Number.isFinite(Number(row?.lead_days_other)) ? Number(row.lead_days_other) : 45,
          };
        } catch {
          try {
            const [[row]] = await pool.execute(
              `SELECT footer, photo_root, min_gap_days FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
            return {
              ...defaults, footer: row?.footer || null, photo_root: row?.photo_root || PHOTO_ROOT,
              min_gap_days: Number.isFinite(Number(row?.min_gap_days)) ? Number(row.min_gap_days) : 40,
            };
          } catch {
            try {
              const [[row]] = await pool.execute(
                `SELECT footer, photo_root FROM advertising_setting WHERE org_id = ? LIMIT 1`, [orgId]);
              return { ...defaults, footer: row?.footer || null, photo_root: row?.photo_root || PHOTO_ROOT };
            } catch { return defaults; }
          }
        }
      }
    }
    }
    }
  }
}

router.get('/settings', authenticate, async (req, res) => {
  try {
    const s = await loadSettings(req.pool, req.user.orgId);
    const effectiveAdvertising = resolveAvailabilityWindows(s, 'advertising');
    const inquiry = resolveAvailabilityWindows(s, 'inquiry');
    res.json({
      code: 200,
      data: {
        ...s,
        effective: {
          advertising: effectiveAdvertising,
          inquiry,
        },
      },
    });
  } catch (err) {
    console.error('[advertising/settings get] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load settings' });
  }
});

router.put('/settings', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const {
      footer,
      photo_root,
      partner_forward_message,
      min_gap_days,
      max_gap_days,
      hard_max_gap_days,
      lead_days_nr,
      lead_days_other,
      inquiry_min_gap_days,
      inquiry_lead_days_nr,
      inquiry_lead_days_other,
      inquiry_booking_horizon_days,
      inquiry_too_far_out_phrase,
      inquiry_gap_band_1m_days,
      inquiry_gap_band_2m_days,
      inquiry_gap_band_3m_plus_days,
      search_gap_band_1m_days,
      search_gap_band_2m_days,
      search_gap_band_3m_plus_days,
    } = req.body || {};
    const bt = nonStringField(req.body || {}, ['footer', 'photo_root', 'partner_forward_message', 'inquiry_too_far_out_phrase']);
    if (bt) return res.status(400).json({ code: 400, message: `${bt} must be text` });
    const normalizedPartnerForwardMessage = partner_forward_message !== undefined
      ? normalizePartnerForwardMessage(partner_forward_message)
      : undefined;
    const normalizedTooFarOutPhrase = inquiry_too_far_out_phrase !== undefined
      ? normalizePartnerForwardMessage(inquiry_too_far_out_phrase)
      : undefined;
    const lenErr = lengthError({
      photo_root,
      partner_forward_message: normalizedPartnerForwardMessage,
      inquiry_too_far_out_phrase: normalizedTooFarOutPhrase,
    }, SETTINGS_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    for (const field of ['min_gap_days', 'max_gap_days', 'hard_max_gap_days', 'lead_days_nr', 'lead_days_other']) {
      if (req.body?.[field] !== undefined
          && (!Number.isInteger(req.body[field]) || req.body[field] < 0 || req.body[field] > 365)) {
        return res.status(400).json({ code: 400, message: `${field} must be an integer between 0 and 365` });
      }
    }
    for (const field of ['inquiry_min_gap_days', 'inquiry_lead_days_nr', 'inquiry_lead_days_other', 'inquiry_booking_horizon_days', 'inquiry_gap_band_1m_days', 'inquiry_gap_band_2m_days', 'inquiry_gap_band_3m_plus_days', 'search_gap_band_1m_days', 'search_gap_band_2m_days', 'search_gap_band_3m_plus_days']) {
      if (req.body?.[field] !== undefined) {
        if (req.body[field] === null) {
          return res.status(400).json({
            code: 400,
            message: `${field} must be an integer between 0 and 365; inquiry and advertising windows are independent, so each inquiry window needs its own value`,
          });
        }
        if (!Number.isInteger(req.body[field]) || req.body[field] < 0 || req.body[field] > 365) {
          return res.status(400).json({ code: 400, message: `${field} must be an integer between 0 and 365` });
        }
      }
    }
    const current = await loadSettings(req.pool, orgId);
    const merged = {
      ...current,
      ...(min_gap_days !== undefined ? { min_gap_days } : {}),
      ...(max_gap_days !== undefined ? { max_gap_days } : {}),
      ...(hard_max_gap_days !== undefined ? { hard_max_gap_days } : {}),
      ...(lead_days_nr !== undefined ? { lead_days_nr } : {}),
      ...(lead_days_other !== undefined ? { lead_days_other } : {}),
    };
    if (merged.max_gap_days > merged.hard_max_gap_days) {
      return res.status(400).json({
        code: 400,
        message: 'max_gap_days must be less than or equal to hard_max_gap_days; a warning threshold above the hide threshold is incoherent because the unit would already be hidden before it could be warned about',
      });
    }
    // PARTIAL upsert — only touch the fields actually sent, so the footer editor
    // (Templates) and photo-root (Forums) can't overwrite each other.
    const setClauses = [];
    if (footer !== undefined) setClauses.push('footer = VALUES(footer)');
    if (photo_root !== undefined) setClauses.push('photo_root = VALUES(photo_root)');
    if (partner_forward_message !== undefined) setClauses.push('partner_forward_message = VALUES(partner_forward_message)');
    if (min_gap_days !== undefined) setClauses.push('min_gap_days = VALUES(min_gap_days)');
    if (max_gap_days !== undefined) setClauses.push('max_gap_days = VALUES(max_gap_days)');
    if (hard_max_gap_days !== undefined) setClauses.push('hard_max_gap_days = VALUES(hard_max_gap_days)');
    if (lead_days_nr !== undefined) setClauses.push('lead_days_nr = VALUES(lead_days_nr)');
    if (lead_days_other !== undefined) setClauses.push('lead_days_other = VALUES(lead_days_other)');
    if (inquiry_min_gap_days !== undefined) setClauses.push('inquiry_min_gap_days = VALUES(inquiry_min_gap_days)');
    if (inquiry_lead_days_nr !== undefined) setClauses.push('inquiry_lead_days_nr = VALUES(inquiry_lead_days_nr)');
    if (inquiry_lead_days_other !== undefined) setClauses.push('inquiry_lead_days_other = VALUES(inquiry_lead_days_other)');
    if (inquiry_booking_horizon_days !== undefined) setClauses.push('inquiry_booking_horizon_days = VALUES(inquiry_booking_horizon_days)');
    if (inquiry_too_far_out_phrase !== undefined) setClauses.push('inquiry_too_far_out_phrase = VALUES(inquiry_too_far_out_phrase)');
    if (inquiry_gap_band_1m_days !== undefined) setClauses.push('inquiry_gap_band_1m_days = VALUES(inquiry_gap_band_1m_days)');
    if (inquiry_gap_band_2m_days !== undefined) setClauses.push('inquiry_gap_band_2m_days = VALUES(inquiry_gap_band_2m_days)');
    if (inquiry_gap_band_3m_plus_days !== undefined) setClauses.push('inquiry_gap_band_3m_plus_days = VALUES(inquiry_gap_band_3m_plus_days)');
    if (search_gap_band_1m_days !== undefined) setClauses.push('search_gap_band_1m_days = VALUES(search_gap_band_1m_days)');
    if (search_gap_band_2m_days !== undefined) setClauses.push('search_gap_band_2m_days = VALUES(search_gap_band_2m_days)');
    if (search_gap_band_3m_plus_days !== undefined) setClauses.push('search_gap_band_3m_plus_days = VALUES(search_gap_band_3m_plus_days)');
    if (!setClauses.length) return res.json({ code: 200, data: { ok: true } });
    const executeUpsert = ({
      includeMaxGap,
      includeHardMaxGap,
      includePartnerForward,
      includeInquiryMinGap,
      includeInquiryLeadNr,
      includeInquiryLeadOther,
      includeInquiryBookingHorizon,
      includeInquiryTooFarOutPhrase,
      includeInquiryGapBand1m,
      includeInquiryGapBand2m,
      includeInquiryGapBand3mPlus,
      includeSearchGapBand1m,
      includeSearchGapBand2m,
      includeSearchGapBand3mPlus,
    }) => {
      const insertColumns = ['org_id', 'footer', 'photo_root'];
      const params = [
        orgId,
        footer !== undefined ? (footer || null) : null,
        photo_root !== undefined ? (photo_root || null) : null,
      ];
      if (includePartnerForward) {
        insertColumns.push('partner_forward_message');
        params.push(normalizedPartnerForwardMessage ?? null);
      }
      insertColumns.push('min_gap_days');
      params.push(min_gap_days ?? 40);
      if (includeMaxGap) {
        insertColumns.push('max_gap_days');
        params.push(max_gap_days ?? 10);
      }
      if (includeHardMaxGap) {
        insertColumns.push('hard_max_gap_days');
        params.push(hard_max_gap_days ?? 20);
      }
      insertColumns.push('lead_days_nr', 'lead_days_other');
      params.push(lead_days_nr ?? 60, lead_days_other ?? 45);
      if (includeInquiryMinGap) {
        insertColumns.push('inquiry_min_gap_days');
        params.push(inquiry_min_gap_days ?? 40);
      }
      if (includeInquiryLeadNr) {
        insertColumns.push('inquiry_lead_days_nr');
        params.push(inquiry_lead_days_nr ?? 60);
      }
      if (includeInquiryLeadOther) {
        insertColumns.push('inquiry_lead_days_other');
        params.push(inquiry_lead_days_other ?? 45);
      }
      if (includeInquiryBookingHorizon) {
        insertColumns.push('inquiry_booking_horizon_days');
        params.push(inquiry_booking_horizon_days ?? 60);
      }
      if (includeInquiryTooFarOutPhrase) {
        insertColumns.push('inquiry_too_far_out_phrase');
        params.push(normalizedTooFarOutPhrase ?? null);
      }
      if (includeInquiryGapBand1m) {
        insertColumns.push('inquiry_gap_band_1m_days');
        params.push(inquiry_gap_band_1m_days ?? 3);
      }
      if (includeInquiryGapBand2m) {
        insertColumns.push('inquiry_gap_band_2m_days');
        params.push(inquiry_gap_band_2m_days ?? 6);
      }
      if (includeInquiryGapBand3mPlus) {
        insertColumns.push('inquiry_gap_band_3m_plus_days');
        params.push(inquiry_gap_band_3m_plus_days ?? 10);
      }
      if (includeSearchGapBand1m) {
        insertColumns.push('search_gap_band_1m_days');
        params.push(search_gap_band_1m_days ?? 3);
      }
      if (includeSearchGapBand2m) {
        insertColumns.push('search_gap_band_2m_days');
        params.push(search_gap_band_2m_days ?? 6);
      }
      if (includeSearchGapBand3mPlus) {
        insertColumns.push('search_gap_band_3m_plus_days');
        params.push(search_gap_band_3m_plus_days ?? 10);
      }
      insertColumns.push('created_at');
      const placeholders = [...params.map(() => '?'), 'NOW()'].join(', ');
      const clauses = setClauses.filter(clause => {
        if (!includeMaxGap && clause.startsWith('max_gap_days')) return false;
        if (!includeHardMaxGap && clause.startsWith('hard_max_gap_days')) return false;
        if (!includePartnerForward && clause.startsWith('partner_forward_message')) return false;
        if (!includeInquiryMinGap && clause.startsWith('inquiry_min_gap_days')) return false;
        if (!includeInquiryLeadNr && clause.startsWith('inquiry_lead_days_nr')) return false;
        if (!includeInquiryLeadOther && clause.startsWith('inquiry_lead_days_other')) return false;
        if (!includeInquiryBookingHorizon && clause.startsWith('inquiry_booking_horizon_days')) return false;
        if (!includeInquiryTooFarOutPhrase && clause.startsWith('inquiry_too_far_out_phrase')) return false;
        if (!includeInquiryGapBand1m && clause.startsWith('inquiry_gap_band_1m_days')) return false;
        if (!includeInquiryGapBand2m && clause.startsWith('inquiry_gap_band_2m_days')) return false;
        if (!includeInquiryGapBand3mPlus && clause.startsWith('inquiry_gap_band_3m_plus_days')) return false;
        if (!includeSearchGapBand1m && clause.startsWith('search_gap_band_1m_days')) return false;
        if (!includeSearchGapBand2m && clause.startsWith('search_gap_band_2m_days')) return false;
        if (!includeSearchGapBand3mPlus && clause.startsWith('search_gap_band_3m_plus_days')) return false;
        return true;
      });
      if (!clauses.length) return Promise.resolve();
      return req.pool.execute(
        `INSERT INTO advertising_setting (${insertColumns.join(', ')})
         VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${clauses.join(', ')}`,
        params
      );
    };
    const optionalColumns = {
      includePartnerForward: {
        column: 'partner_forward_message',
        wasSent: partner_forward_message !== undefined,
      },
      includeHardMaxGap: {
        column: 'hard_max_gap_days',
        wasSent: hard_max_gap_days !== undefined,
      },
      includeMaxGap: {
        column: 'max_gap_days',
        wasSent: max_gap_days !== undefined,
      },
      includeInquiryMinGap: {
        column: 'inquiry_min_gap_days',
        wasSent: inquiry_min_gap_days !== undefined,
      },
      includeInquiryLeadNr: {
        column: 'inquiry_lead_days_nr',
        wasSent: inquiry_lead_days_nr !== undefined,
      },
      includeInquiryLeadOther: {
        column: 'inquiry_lead_days_other',
        wasSent: inquiry_lead_days_other !== undefined,
      },
      includeInquiryBookingHorizon: {
        column: 'inquiry_booking_horizon_days',
        wasSent: inquiry_booking_horizon_days !== undefined,
      },
      includeInquiryTooFarOutPhrase: {
        column: 'inquiry_too_far_out_phrase',
        wasSent: inquiry_too_far_out_phrase !== undefined,
      },
      includeInquiryGapBand1m: {
        column: 'inquiry_gap_band_1m_days',
        wasSent: inquiry_gap_band_1m_days !== undefined,
      },
      includeInquiryGapBand2m: {
        column: 'inquiry_gap_band_2m_days',
        wasSent: inquiry_gap_band_2m_days !== undefined,
      },
      includeInquiryGapBand3mPlus: {
        column: 'inquiry_gap_band_3m_plus_days',
        wasSent: inquiry_gap_band_3m_plus_days !== undefined,
      },
      includeSearchGapBand1m: {
        column: 'search_gap_band_1m_days',
        wasSent: search_gap_band_1m_days !== undefined,
      },
      includeSearchGapBand2m: {
        column: 'search_gap_band_2m_days',
        wasSent: search_gap_band_2m_days !== undefined,
      },
      includeSearchGapBand3mPlus: {
        column: 'search_gap_band_3m_plus_days',
        wasSent: search_gap_band_3m_plus_days !== undefined,
      },
    };
    const flags = {
      includeMaxGap: true,
      includeHardMaxGap: true,
      includePartnerForward: true,
      includeInquiryMinGap: true,
      includeInquiryLeadNr: true,
      includeInquiryLeadOther: true,
      includeInquiryBookingHorizon: true,
      includeInquiryTooFarOutPhrase: true,
      includeInquiryGapBand1m: true,
      includeInquiryGapBand2m: true,
      includeInquiryGapBand3mPlus: true,
      includeSearchGapBand1m: true,
      includeSearchGapBand2m: true,
      includeSearchGapBand3mPlus: true,
    };
    while (true) {
      try {
        await executeUpsert(flags);
        break;
      } catch (err) {
        const missing = Object.entries(optionalColumns).find(([flag, info]) => (
          flags[flag] && !info.wasSent && isMissingColumn(err, info.column)
        ));
        if (!missing) throw err;
        flags[missing[0]] = false;
      }
    }
    res.json({ code: 200, data: { ok: true } });
  } catch (err) {
    console.error('[advertising/settings put] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to save settings' });
  }
});

async function buildPostingPlan(pool, orgId, { date } = {}) {
    const planDate = date ? String(date) : todayYmd();
    const weekday = weekdayOf(planDate);
    if (weekday == null) { const error = new Error('invalid_date'); error.httpStatus = 400; throw error; }
    const settings = await loadSettings(pool, orgId);
    const { vacancies } = await computeVacancies(pool, orgId, { settings });
    const bundles = buildBundles(vacancies);

    const [scheduleRows] = await pool.execute(
      `SELECT s.id, s.weekday, s.slot_kind, s.slot_no, s.position,
              f.id AS forum_id, f.name AS forum_name, f.url, f.is_owned,
              a.id AS account_id, a.name AS account_name, a.email AS account_email
         FROM advertising_schedule s
         JOIN advertising_forum f ON f.id = s.forum_id AND f.org_id = s.org_id
          AND f.deleted_at IS NULL AND f.status = 1
         JOIN advertising_account a ON a.id = s.account_id AND a.org_id = s.org_id
          AND a.deleted_at IS NULL AND a.status = 1
         JOIN advertising_forum_account fa ON fa.org_id = s.org_id
          AND fa.forum_id = s.forum_id AND fa.account_id = s.account_id
        WHERE s.org_id = ? AND s.weekday = ? AND s.deleted_at IS NULL AND s.status = 1
        ORDER BY s.position`,
      [orgId, weekday]
    );
    const slots = scheduleRows.map(r => ({
      id: String(r.id),
      weekday: Number(r.weekday),
      slot_kind: r.slot_kind,
      slot_no: Number(r.slot_no),
      slot_label: slotLabel(r),
      position: Number(r.position),
      forum: {
        forum_id: String(r.forum_id),
        forum_name: r.forum_name,
        url: r.url,
        is_owned: Number(r.is_owned) === 1 ? 1 : 0,
      },
      account: {
        id: String(r.account_id),
        name: r.account_name,
        email: r.account_email,
      },
    }));
    const allocation = assignBundlesToSlots(bundles, slots, { tierOf: b => b.tier });
    const templateCache = new Map();        // template_id → row (many bundles share one)
    const posts = [];

    for (const { bundle: b, slot, extra } of allocation.assignments) {
      if (!b.template_id) {
        posts.push({ ...bundleSummary(b), status: 'needs_template',
          reason: 'Assign a template before this can be posted',
          extra,
          slot_id: slot.id, slot_label: slot.slot_label, slot_kind: slot.slot_kind, slot_no: slot.slot_no, position: slot.position,
          forum: slot.forum, account: slot.account });
        continue;
      }
      let tpl = templateCache.get(b.template_id);
      if (tpl === undefined) {
        const [[row]] = await pool.execute(
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
          reason: 'Template was deleted',
          extra,
          slot_id: slot.id, slot_label: slot.slot_label, slot_kind: slot.slot_kind, slot_no: slot.slot_no, position: slot.position,
          forum: slot.forum, account: slot.account });
        continue;
      }
      const rendered = await renderBundle(pool, orgId, b, tpl, settings.footer);

      posts.push({
        ...bundleSummary(b, rendered),
        status: 'ready',
        reason: null,
        extra,
        slot_id: slot.id,
        slot_label: slot.slot_label,
        slot_kind: slot.slot_kind,
        slot_no: slot.slot_no,
        position: slot.position,
        template_id: String(b.template_id), template_name: b.template_name,
        post_text: rendered ? rendered.text : null,
        rendered,
        forum: slot.forum,
        account: slot.account,
      });
    }
    for (const b of allocation.overflow) {
      posts.push({ ...bundleSummary(b), status: 'no_slot', extra: false,
        reason: `No slot left on ${dayLabel(weekday)} — add a row to the schedule`,
        forum: null, account: null });
    }
    const unfilledReason = bundles.length === 0
      ? 'nothing to advertise'
      : 'every available property already posts to this group today';
    const unfilledSlots = allocation.unfilled.map(slot => ({
      id: slot.id,
      weekday: slot.weekday,
      slot_kind: slot.slot_kind,
      slot_no: slot.slot_no,
      slot_label: slot.slot_label,
      position: slot.position,
      forum: slot.forum,
      account: slot.account,
      reason: unfilledReason,
    }));

    const tier_counts = {
      vacant: vacancies.filter(v => v.tier === 1).length,
      nr: vacancies.filter(v => v.tier === 2).length,
      other: vacancies.filter(v => v.tier === 3).length,
    };
    return {
        date: planDate,
        weekday,
        day_name: dayLabel(weekday),
        photo_root: settings.photo_root,
        min_gap_days: settings.min_gap_days,
        lead_days_nr: settings.lead_days_nr,
        lead_days_other: settings.lead_days_other,
        tier_counts,
        slot_count: slots.length,
        extra_count: allocation.assignments.filter(a => a.extra).length,
        unfilled_slots: unfilledSlots,
        posts,
      };
}

router.get('/posting-plan', authenticate, async (req, res) => {
  try {
    const data = await buildPostingPlan(req.pool, req.user.orgId, { date: req.query.date });
    res.json({ code: 200, data });
  } catch (err) {
    if (err.httpStatus === 400) return res.status(400).json({ code: 400, message: err.message });
    console.error('[advertising/posting-plan] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to build posting plan' });
  }
});

function bundleSummary(b, rendered = null) {
  return {
    property_id: b.property_id ? String(b.property_id) : null,
    property_name: b.property_name,
    unit_ids: b.units.map(u => String(u.unit_id)),
    unit_names: b.units.map(u => u.unit_name),
    unit_prices: postingPrices(b, rendered),
    tier: b.tier,
    intent: b.intent,
    image_hint: b.units.map(u => `${b.property_name}/${u.unit_name}`),
  };
}

// Log a post (or skip) — idempotency + rotation history. The agent calls this
// after it (or the human) posts, so the next plan won't reuse that forum.
async function markPostingPlan(pool, orgId, body) {
    const b = body || {};
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
      const [[row]] = await pool.execute(
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
    await pool.execute(
      `INSERT INTO advertising_post_log (id, org_id, post_date, property_id, template_id, forum_id, account_id, unit_ids, source, status, created_at)
       VALUES (?, ?, COALESCE(?, ${orgTodaySql()}), ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, orgId, post_date, propertyId, templateId, forumId, accountId, unit_ids, source, status]
    );
    return { id };
}

router.post('/posting-plan/mark', authenticate, async (req, res) => {
  try {
    const data = await markPostingPlan(req.pool, req.user.orgId, req.body);
    res.json({ code: 200, data });
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

function normalizePartnerForwardMessage(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  // A whitespace-only partner-forward message must not count as authored; the
  // caller would otherwise send a blank message to real partner agencies.
  return trimmed === '' ? null : trimmed;
}

function parseForumFlags(body, { partial = false } = {}) {
  const out = {};
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'is_owned')) {
    const raw = body.is_owned == null ? 0 : Number(body.is_owned);
    if (!(raw === 0 || raw === 1)) return { ok: false, error: 'is_owned must be 0 or 1' };
    out.is_owned = raw;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'max_per_week')) {
    if (body.max_per_week === null || body.max_per_week === '' || body.max_per_week === undefined) {
      out.max_per_week = null;
    } else {
      const raw = Number(body.max_per_week);
      if (!Number.isInteger(raw) || raw < 0) return { ok: false, error: 'max_per_week must be a non-negative integer or null' };
      out.max_per_week = raw;
    }
  }
  return { ok: true, value: out };
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

async function loadScheduleRows(pool, orgId) {
  const [rows] = await pool.execute(
    `SELECT s.id, s.weekday, s.slot_kind, s.slot_no, s.position,
            f.id AS forum_id, f.name AS forum_name, f.url, f.is_owned, f.max_per_week,
            a.id AS account_id, a.name AS account_name, a.email AS account_email
       FROM advertising_schedule s
       JOIN advertising_forum f ON f.id = s.forum_id AND f.org_id = s.org_id
        AND f.deleted_at IS NULL
       JOIN advertising_account a ON a.id = s.account_id AND a.org_id = s.org_id
        AND a.deleted_at IS NULL
      WHERE s.org_id = ? AND s.deleted_at IS NULL AND s.status = 1
      ORDER BY s.weekday, s.position`,
    [orgId]
  );
  return rows.map(r => ({
    id: String(r.id),
    weekday: Number(r.weekday),
    slot_kind: r.slot_kind,
    slot_no: Number(r.slot_no),
    slot_key: `${r.slot_kind}:${Number(r.slot_no)}`,
    slot_label: slotLabel(r),
    position: Number(r.position),
    forum_id: String(r.forum_id),
    forum_name: r.forum_name,
    url: r.url,
    is_owned: Number(r.is_owned) === 1 ? 1 : 0,
    max_per_week: r.max_per_week == null ? null : Number(r.max_per_week),
    account_id: String(r.account_id),
    account_name: r.account_name,
    account_email: r.account_email,
  }));
}

async function loadForumsWithAccounts(pool, orgId) {
  const [rows] = await pool.execute(
    `SELECT f.id AS forum_id, f.name AS forum_name, f.url, f.is_owned, f.max_per_week,
            a.id AS account_id, a.email AS account_email
       FROM advertising_forum f
       LEFT JOIN advertising_forum_account fa ON fa.forum_id = f.id AND fa.org_id = f.org_id
       LEFT JOIN advertising_account a ON a.id = fa.account_id AND a.org_id = f.org_id
        AND a.deleted_at IS NULL AND a.status = 1
      WHERE f.org_id = ? AND f.deleted_at IS NULL AND f.status = 1
      ORDER BY f.name, a.email`,
    [orgId]
  );
  const forums = new Map();
  for (const r of rows) {
    const key = String(r.forum_id);
    if (!forums.has(key)) {
      forums.set(key, {
        forum_id: key,
        forum_name: r.forum_name,
        url: r.url,
        is_owned: Number(r.is_owned) === 1 ? 1 : 0,
        max_per_week: r.max_per_week == null ? null : Number(r.max_per_week),
        accounts: [],
      });
    }
    if (r.account_id) forums.get(key).accounts.push({ id: String(r.account_id), email: r.account_email });
  }
  return [...forums.values()];
}

async function validateForumAccountMember(pool, orgId, forumId, accountId) {
  const [[row]] = await pool.execute(
    `SELECT 1 FROM advertising_forum_account fa
      JOIN advertising_forum f ON f.id = fa.forum_id AND f.org_id = fa.org_id
       AND f.deleted_at IS NULL AND f.status = 1
      JOIN advertising_account a ON a.id = fa.account_id AND a.org_id = fa.org_id
       AND a.deleted_at IS NULL AND a.status = 1
     WHERE fa.org_id = ? AND fa.forum_id = ? AND fa.account_id = ?
     LIMIT 1`,
    [orgId, forumId, accountId]
  );
  return !!row;
}

router.get('/schedule', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows, forums] = await Promise.all([
      loadScheduleRows(req.pool, orgId),
      loadForumsWithAccounts(req.pool, orgId),
    ]);
    const days = DAY_NAMES.map((name, weekday) => ({
      weekday,
      name,
      slots: rows.filter(r => r.weekday === weekday).map(r => ({
        id: r.id,
        weekday: r.weekday,
        slot_kind: r.slot_kind,
        slot_no: r.slot_no,
        slot_label: r.slot_label,
        position: r.position,
        forum: {
          forum_id: r.forum_id,
          forum_name: r.forum_name,
          url: r.url,
          is_owned: r.is_owned,
        },
        account: {
          id: r.account_id,
          name: r.account_name,
          email: r.account_email,
        },
      })),
    }));
    res.json({ code: 200, data: { days, weekly_totals: forumWeeklyLoad(rows, forums) } });
  } catch (err) {
    console.error('[advertising/schedule] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load schedule' });
  }
});

router.get('/schedule-violations', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows, forums] = await Promise.all([
      loadScheduleRows(req.pool, orgId),
      loadForumsWithAccounts(req.pool, orgId),
    ]);
    const violations = findRepeatViolations(rows).map(v => ({
      ...v,
      rows: rows
        .filter(r => r.slot_key === v.slot_key && r.forum_id === v.forum_id)
        .map(r => ({ id: r.id, weekday: r.weekday, day_name: dayLabel(r.weekday), position: r.position })),
      suggestions: suggestReplacements(v, rows, forums),
    }));
    res.json({ code: 200, data: { violations } });
  } catch (err) {
    console.error('[advertising/schedule-violations] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load schedule violations' });
  }
});

router.put('/schedule/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[existing]] = await req.pool.execute(
      `SELECT id, forum_id, account_id FROM advertising_schedule
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!existing) return res.status(404).json({ code: 404, message: 'Schedule row not found' });
    const forumId = req.body && req.body.forum_id !== undefined ? String(req.body.forum_id) : String(existing.forum_id);
    const accountId = req.body && req.body.account_id !== undefined ? String(req.body.account_id) : String(existing.account_id);
    if (!(await validateForumAccountMember(req.pool, orgId, forumId, accountId))) {
      return res.status(400).json({ code: 400, message: 'Selected account is not a member of that forum' });
    }
    await req.pool.execute(
      `UPDATE advertising_schedule SET forum_id = ?, account_id = ? WHERE id = ? AND org_id = ?`,
      [forumId, accountId, req.params.id, orgId]
    );
    res.json({ code: 200, data: { id: String(req.params.id) } });
  } catch (err) {
    console.error('[advertising/schedule update] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update schedule row' });
  }
});

// ---- Forums ---- (list includes member account ids for the membership editor)
router.get('/schedule-grid', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT f.id AS forum_id, f.name AS forum_name, f.url, f.post_days, f.is_owned, f.max_per_week,
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
          is_owned: Number(r.is_owned) === 1 ? 1 : 0,
          max_per_week: r.max_per_week == null ? null : Number(r.max_per_week),
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
      `SELECT id, name, url, notes, status, post_days, is_owned, max_per_week FROM advertising_forum
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
      is_owned: Number(f.is_owned) === 1 ? 1 : 0,
      max_per_week: f.max_per_week == null ? null : Number(f.max_per_week),
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
    const flags = parseForumFlags(req.body || {});
    if (!flags.ok) return res.status(400).json({ code: 400, message: flags.error });
    if (!name || !String(name).trim()) return res.status(400).json({ code: 400, message: 'Forum name is required' });
    const lenErr = lengthError({ name, url }, FORUM_LIMITS);
    if (lenErr) return res.status(400).json({ code: 400, message: lenErr });
    const id = newId();
    await req.pool.execute(
      `INSERT INTO advertising_forum (id, org_id, name, url, notes, post_days, is_owned, max_per_week, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, req.user.orgId, String(name).trim(), url || null, notes || null, days.value, flags.value.is_owned, flags.value.max_per_week]
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
    const flags = parseForumFlags(req.body || {}, { partial: true });
    if (!flags.ok) return res.status(400).json({ code: 400, message: flags.error });
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
    if (Object.prototype.hasOwnProperty.call(flags.value, 'is_owned')) { fields.push('is_owned = ?'); params.push(flags.value.is_owned); }
    if (Object.prototype.hasOwnProperty.call(flags.value, 'max_per_week')) { fields.push('max_per_week = ?'); params.push(flags.value.max_per_week); }
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
module.exports.buildPostingPlan = buildPostingPlan;
module.exports.markPostingPlan = markPostingPlan;
module.exports.computeVacancies = computeVacancies;
module.exports.findBeyondHorizonNrVacancies = findBeyondHorizonNrVacancies;
module.exports.loadSettings = loadSettings;
module.exports.deriveDefaultVacancyExpiry = deriveDefaultVacancyExpiry;
module.exports.postingPrices = postingPrices;

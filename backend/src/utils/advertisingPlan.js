const { orgTodaySql } = require('./orgTime');

function slotKey(row) {
  return `${String(row && row.slot_kind || '').toLowerCase()}:${Number(row && row.slot_no)}`;
}

function slotLabel(row) {
  const kind = String(row && row.slot_kind || '').toLowerCase();
  const prefix = kind === 'urgent' ? 'Urgent' : 'Prop';
  return `${prefix} ${Number(row && row.slot_no)}`;
}

function naturalSlotCompare(a, b) {
  const ak = String(a.slot_key || '');
  const bk = String(b.slot_key || '');
  const [akind, ano] = ak.split(':');
  const [bkind, bno] = bk.split(':');
  if (akind !== bkind) return akind.localeCompare(bkind);
  return Number(ano) - Number(bno);
}

function findRepeatViolations(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${slotKey(row)}|${String(row.forum_id)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        slot_key: slotKey(row),
        slot_label: slotLabel(row),
        forum_id: String(row.forum_id),
        forum_name: row.forum_name || '',
        is_owned: Number(row.is_owned) === 1 ? 1 : 0,
        count: 0,
        weekdays: new Set(),
      });
    }
    const item = groups.get(key);
    item.count += 1;
    item.weekdays.add(Number(row.weekday));
  }
  return [...groups.values()]
    .filter(item => item.count > 1)
    .map(item => ({ ...item, weekdays: [...item.weekdays].sort((a, b) => a - b) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.is_owned !== b.is_owned) return a.is_owned - b.is_owned;
      return naturalSlotCompare(a, b);
    });
}

function normalizeForum(forum) {
  return {
    forum_id: String(forum.forum_id || forum.id),
    forum_name: forum.forum_name || forum.name || '',
    is_owned: Number(forum.is_owned) === 1 ? 1 : 0,
    max_per_week: forum.max_per_week == null ? null : Number(forum.max_per_week),
    accounts: Array.isArray(forum.accounts)
      ? forum.accounts.map(a => ({ id: String(a.id), email: a.email || '' }))
      : [],
  };
}

function suggestReplacements(violation, rows, forums) {
  if (!violation || !Array.isArray(rows) || !Array.isArray(forums) || forums.length === 0) return [];
  const usedBySlot = new Set(rows
    .filter(row => slotKey(row) === violation.slot_key)
    .map(row => String(row.forum_id)));
  const counts = new Map();
  for (const row of rows) {
    const forumId = String(row.forum_id);
    counts.set(forumId, (counts.get(forumId) || 0) + 1);
  }
  return forums
    .map(normalizeForum)
    .filter(forum => !usedBySlot.has(forum.forum_id) && forum.accounts.length > 0)
    .map(forum => ({ ...forum, weekly_count: counts.get(forum.forum_id) || 0 }))
    .sort((a, b) => {
      if (a.is_owned !== b.is_owned) return b.is_owned - a.is_owned;
      if (!a.is_owned && a.weekly_count !== b.weekly_count) return a.weekly_count - b.weekly_count;
      return a.forum_name.localeCompare(b.forum_name);
    })
    .slice(0, 5)
    .map(({ max_per_week, ...forum }) => forum);
}

function forumWeeklyLoad(rows, forums) {
  if ((!Array.isArray(rows) || rows.length === 0) && (!Array.isArray(forums) || forums.length === 0)) return [];
  const byForum = new Map();
  for (const forum of Array.isArray(forums) ? forums : []) {
    const f = normalizeForum(forum);
    byForum.set(f.forum_id, { ...f, count: 0 });
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const forumId = String(row.forum_id);
    if (!byForum.has(forumId)) {
      byForum.set(forumId, {
        forum_id: forumId,
        forum_name: row.forum_name || '',
        is_owned: Number(row.is_owned) === 1 ? 1 : 0,
        max_per_week: row.max_per_week == null ? null : Number(row.max_per_week),
        accounts: [],
        count: 0,
      });
    }
    byForum.get(forumId).count += 1;
  }
  return [...byForum.values()]
    .map(({ accounts, ...forum }) => ({
      ...forum,
      over_cap: Number(forum.is_owned) !== 1 && forum.max_per_week != null && forum.count > forum.max_per_week,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.forum_name.localeCompare(b.forum_name);
    });
}

/**
 * Is a unit that is empty today worth advertising?
 * A missing next move-in means there is no booked next lease.
 */
function gapIsAdvertisable(daysToMoveIn, minGapDays) {
  if (daysToMoveIn == null) return true;
  const days = typeof daysToMoveIn === 'number' ? daysToMoveIn : Number.NaN;
  const configuredMinimum = typeof minGapDays === 'number' ? minGapDays : Number.NaN;
  const minimum = Number.isFinite(configuredMinimum) ? configuredMinimum : 40;
  return Number.isFinite(days) && days > 0 && days >= minimum;
}

const PRIORITY_VACANT = 1;
const PRIORITY_NR = 2;
const PRIORITY_OTHER = 3;

// Is this availability-window value actually SET, as opposed to blank or junk?
//
// Number() is too permissive on its own: Number('  ') and Number([]) are both 0, and
// Number(true) is 1 — so a whitespace-only or non-scalar value would read as a
// deliberate 0, i.e. "no minimum gap". That is a LOOSER policy arrived at by accident,
// which is the wrong direction to fail in. Only a number or a numeric string counts.
// The API already validates 0-365 on write, so this only guards against values written
// straight to the database.
function hasAvailabilityValue(value) {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false; // objects, arrays, booleans
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return Number.isFinite(Number(trimmed));
}

function availabilityNumber(value, fallback) {
  return hasAvailabilityValue(value) ? Number(value) : fallback;
}

/**
 * Effective availability windows for one audience.
 * audience: 'advertising' | 'inquiry'
 * Inquiry and advertising values are independent; missing or junk values fall back
 * only to that audience's own hardcoded defaults.
 */
function resolveAvailabilityWindows(settings, audience) {
  const fields = audience === 'inquiry'
    ? {
      min_gap_days: 'inquiry_min_gap_days',
      lead_days_nr: 'inquiry_lead_days_nr',
      lead_days_other: 'inquiry_lead_days_other',
    }
    : {
      min_gap_days: 'min_gap_days',
      lead_days_nr: 'lead_days_nr',
      lead_days_other: 'lead_days_other',
    };
  const sourceName = audience === 'inquiry' ? 'inquiry' : 'advertising';
  const values = {
    min_gap_days: availabilityNumber(settings?.[fields.min_gap_days], 40),
    lead_days_nr: availabilityNumber(settings?.[fields.lead_days_nr], 60),
    lead_days_other: availabilityNumber(settings?.[fields.lead_days_other], 45),
  };
  return {
    ...values,
    source: {
      min_gap_days: sourceName,
      lead_days_nr: sourceName,
      lead_days_other: sourceName,
    },
  };
}

function formatLocalDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const text = String(value);
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) return null;
  return formatLocalDate(parsed);
}

function parseYmdStrict(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day, time: Date.UTC(year, month - 1, day) };
}

function diffLocalDays(fromDate, toDate) {
  const from = parseYmdStrict(formatLocalDate(fromDate));
  const to = parseYmdStrict(formatLocalDate(toDate));
  if (!from || !to) return null;
  return Math.round((to.time - from.time) / 86400000);
}

function moneyString(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function tierName(tier) {
  if (Number(tier) === PRIORITY_VACANT) return 'VACANT';
  if (Number(tier) === PRIORITY_NR) return 'NR';
  return 'MR/other';
}

function vacancyToPublicShape(row) {
  const tier = Number(row?.tier);
  const endDate = formatLocalDate(row?.end_date);
  // Same-day turnover: a lease ending on D means the unit is free on D, matching
  // days_until from DATEDIFF(end_date, today). Do not shift to D+1.
  const availableFrom = tier === PRIORITY_VACANT ? null : endDate;
  const certaintyByTier = tier === PRIORITY_VACANT || tier === PRIORITY_NR;
  const source = row?.source === 'manual' ? 'manual' : 'lease';
  // `certain: false` is what TaneChat branches on: offer the unit only with the
  // caveat wording, because an MR/MTM/UC tenant may renew and the unit may never
  // become free.
  const certain = tier === PRIORITY_VACANT ? true : Boolean(certaintyByTier && endDate);

  return {
    unit_id: row?.unit_id == null ? null : String(row.unit_id),
    unit_name: row?.unit_name ?? null,
    listing_url: row?.listing_url ?? null,
    property_id: row?.property_id == null ? null : String(row.property_id),
    property_name: row?.property_name ?? null,
    district: row?.district ?? null,
    city: row?.city ?? null,
    label: [row?.property_name, row?.unit_name].filter(Boolean).join(' ') || null,
    unit_type: row?.unit_type ?? null,
    beds: row?.beds != null ? Number(row.beds) : null,
    baths: row?.baths != null ? Number(row.baths) : null,
    size: row?.size != null ? Number(row.size) : null,
    rent: moneyString(row?.rent),
    tier,
    tier_name: tierName(tier),
    intent: row?.intent ?? null,
    source,
    availability: {
      status: tier === PRIORITY_VACANT ? 'now' : 'from_date',
      available_from: availableFrom,
      next_move_in_date: row?.next_move_in_date ?? null,
      days_until: tier === PRIORITY_VACANT ? 0 : (row?.days_left != null ? Number(row.days_left) : null),
      certain,
    },
  };
}

function manualVacancyToRow(override, unitRow, today) {
  const availableFrom = formatLocalDate(override?.available_from);
  // end_date is the public available_from; storing the same day keeps the
  // override round-trip exact through vacancyToPublicShape.
  const endDate = availableFrom;
  return {
    status: 'manual',
    lease_id: null,
    contract_type: null,
    notice_period_days: null,
    intent: 'Manual',
    days_left: diffLocalDays(today, availableFrom),
    end_date: endDate,
    vacant_since: null,
    rent: unitRow?.rent != null ? Number(unitRow.rent) : null,
    deposit: null,
    unit_id: unitRow?.unit_id == null ? null : String(unitRow.unit_id),
    unit_name: unitRow?.unit_name,
    unit_type: unitRow?.unit_type,
    beds: unitRow?.beds != null ? Number(unitRow.beds) : null,
    baths: unitRow?.baths != null ? Number(unitRow.baths) : null,
    size: unitRow?.size != null ? Number(unitRow.size) : null,
    rent_price_min: unitRow?.rent_price_min != null ? Number(unitRow.rent_price_min) : null,
    rent_price_max: unitRow?.rent_price_max != null ? Number(unitRow.rent_price_max) : null,
    template_id: unitRow?.template_id ? String(unitRow.template_id) : null,
    template_name: unitRow?.template_name || null,
    property_id: unitRow?.property_id == null ? null : String(unitRow.property_id),
    property_name: unitRow?.property_name,
    street_address: unitRow?.street_address,
    district: unitRow?.district,
    city: unitRow?.city,
    tenant_id: null,
    tenant_name: null,
    moveout_notes: null,
    moved_out_early: false,
    next_move_in_date: null,
    days_to_move_in: null,
    next_tenant_id: null,
    next_tenant_name: null,
    tier: PRIORITY_OTHER,
    priority_reason: 'manual',
    source: 'manual',
    override_id: override?.id == null ? null : String(override.id),
    override_lease_id: override?.lease_id == null ? null : String(override.lease_id),
    current_lease_id: override?.current_lease_id == null ? null : String(override.current_lease_id),
    lease_changed: override?.lease_changed === true || Number(override?.lease_changed) === 1,
    expires_on: formatLocalDate(override?.expires_on),
    reason: override?.reason ?? null,
  };
}

function leaseChangedForOverride(override) {
  if (override?.lease_id == null) return false;
  return String(override.lease_id) !== String(override?.current_lease_id ?? '');
}

function overrideAppliesTo(override, audience, { page = false } = {}) {
  if (!page && leaseChangedForOverride(override)) return false;
  if (page) return true;
  if (audience === 'inquiry') return Number(override?.inquiry_enabled) === 1;
  return Number(override?.advertising_enabled) === 1;
}

function pickVacancyRow(manualRow, leaseRow) {
  if (!manualRow) return leaseRow || null;
  if (!leaseRow) return manualRow || null;

  const leaseAvailability = vacancyToPublicShape(leaseRow).availability;
  if (leaseAvailability.status === 'now') return leaseRow;

  const manualDate = vacancyToPublicShape(manualRow).availability.available_from;
  const leaseDate = leaseAvailability.available_from;

  // A manual override is newer information than a contract nobody has amended
  // yet, so it wins only when it brings the offered date forward. Otherwise the
  // lease row is the simpler truth and the override self-retires from output.
  return manualDate && leaseDate && manualDate < leaseDate ? manualRow : leaseRow;
}

async function hasActiveManualVacancyOverride(pool, orgId, unitId) {
  const [[row]] = await pool.execute(
    `SELECT m.id
       FROM manual_vacancy_override m
       JOIN unit u ON u.id = m.unit_id
       JOIN property p ON p.id = u.property_id
       LEFT JOIN leasing cl ON cl.id = (
         SELECT l.id FROM leasing l
          WHERE l.unit_id = m.unit_id
            AND l.deleted_at IS NULL
            AND l.start_date <= ${orgTodaySql()}
            AND (l.end_date IS NULL OR l.end_date >= ${orgTodaySql()})
          ORDER BY l.start_date DESC, l.id DESC LIMIT 1)
      WHERE m.org_id = ?
        AND p.org_id = ?
        AND m.unit_id = ?
        AND m.status = 1
        AND m.expires_on >= ${orgTodaySql()}
        AND (m.lease_id IS NULL OR m.lease_id = cl.id)
      LIMIT 1`,
    [orgId, orgId, unitId]
  );
  return !!row;
}

// Why a unit passes or fails free_on, not just whether. Failing for the two
// reasons below means two different things to a customer: one is worth offering
// on a later date, the other is gone. Collapsing them into a boolean is what made
// six lettable flats read as "nothing available".
function classifyFreeOn(vacancy, freeOn) {
  const availability = vacancy?.availability || {};
  // These are zero-padded YYYY-MM-DD strings, so lexicographic comparison is
  // date comparison without introducing timezone conversion.
  const availableByThen = availability.status === 'now'
    || (availability.available_from != null && availability.available_from <= freeOn);
  const noIncomingTenantByThen = availability.next_move_in_date == null
    || availability.next_move_in_date > freeOn;

  // Checked FIRST, and it overrides everything: once someone else moves in by the
  // requested date the unit is spoken for, however soon it might free up again.
  if (!noIncomingTenantByThen) return 'unavailable';
  if (availableByThen) return 'match';
  // Frees up later, but we cannot say when. There is no date to put in the "would
  // a later start work?" question, so offering it would be an empty promise.
  if (availability.available_from == null) return 'unavailable';
  return 'later';
}

function matchesFreeOn(vacancy, freeOn) {
  return classifyFreeOn(vacancy, freeOn) === 'match';
}

const EMPTY_VACANCY_FIT = {
  gap_days: null,
  gap_warning: null,
  available_after_target: null,
};

/**
 * How well does a unit's availability fit when the prospect wants to move in?
 * row: the public-shaped vacancy (tier + availability{available_from,status})
 * targetDate / today: 'YYYY-MM-DD'
 * Returns { gap_days, gap_warning, available_after_target } — or all null when
 * there is nothing to compare.
 */
function vacancyFit(row, targetDate, { maxGapDays = 10, today } = {}) {
  const target = parseYmdStrict(targetDate);
  if (!target) return { ...EMPTY_VACANCY_FIT };

  let effectiveAvailableFrom = null;
  const availability = row?.availability || {};
  if (Number(row?.tier) === PRIORITY_VACANT && availability.status === 'now') {
    // Tier-1 `available_from:null` means "available now", not "unknown". Treat it
    // as today so currently-vacant units remain rankable for a future move-in.
    effectiveAvailableFrom = today;
  } else {
    effectiveAvailableFrom = availability.available_from;
  }

  const available = parseYmdStrict(effectiveAvailableFrom);
  if (!available) return { ...EMPTY_VACANCY_FIT };

  // Sign convention: gap_days = targetDate - effectiveAvailableFrom.
  // Positive = lost-rent vacancy before the prospect arrives; zero = exact fit;
  // negative = the unit is free after the target, so the prospect waits instead.
  const gapDays = Math.round((target.time - available.time) / 86400000);
  const configuredMax = Number(maxGapDays);
  const threshold = Number.isFinite(configuredMax) ? Math.trunc(configuredMax) : 10;
  const availableAfterTarget = gapDays < 0;

  // A negative gap costs no rent; it is exposed separately so the caller can say
  // the prospect would need to wait rather than treating it as a vacancy warning.
  return {
    gap_days: gapDays,
    gap_warning: gapDays > threshold,
    available_after_target: availableAfterTarget,
  };
}

// Should this unit be withheld from an inquiry answer?
function exceedsHardGapCap(unit, hardMaxGapDays) {
  const configuredCap = Number(hardMaxGapDays);
  if (!Number.isFinite(configuredCap)) return false;

  const gapDays = Number(unit?.gap_days);
  if (!Number.isFinite(gapDays)) return false;
  if (Number(unit?.tier) === PRIORITY_VACANT) return false;
  if (unit?.available_after_target === true || gapDays < 0) return false;

  return gapDays > Math.trunc(configuredCap);
}

// A caller may act on this to forward the inquiry, so this must describe only
// observable route decisions and never infer why a unit was unavailable.
function vacancyNoMatchReason(returnedCount, hiddenByGapCap, hiddenByFreeOn = 0) {
  if (Number(returnedCount) > 0) return null;
  if (Number(hiddenByFreeOn) > 0) return 'none_free_on_date';
  return Number(hiddenByGapCap) > 0 ? 'all_beyond_hard_cap' : 'no_vacancies';
}

// { applies, message } for the partner-forward block. `applies` is only about
// the returned count; no_match_reason is internal reporting, not caller logic.
function partnerForwardBlock(returnedCount, storedMessage) {
  const text = storedMessage == null ? null : String(storedMessage);
  return {
    applies: Number(returnedCount) === 0,
    message: text && text.trim() ? text : null,
  };
}

function fitRank(row) {
  const gapDays = row?.gap_days;
  if (typeof gapDays === 'number' && Number.isFinite(gapDays)) {
    return gapDays >= 0
      ? { group: 0, value: gapDays }
      : { group: 1, value: Math.abs(gapDays) };
  }
  return { group: 2, value: Number.POSITIVE_INFINITY };
}

// Best fit first: exact/near matches, then increasing vacancy, then units that
// are not free until after the target date.
function compareVacancyFit(a, b) {
  const ar = fitRank(a);
  const br = fitRank(b);
  if (ar.group !== br.group) return ar.group - br.group;
  if (ar.value !== br.value) return ar.value - br.value;

  const tierDifference = Number(a?.tier || 0) - Number(b?.tier || 0);
  if (tierDifference) return tierDifference;

  const aLabel = [a?.property_name, a?.unit_name].filter(Boolean).join(' ') || a?.label || '';
  const bLabel = [b?.property_name, b?.unit_name].filter(Boolean).join(' ') || b?.label || '';
  return String(aLabel).localeCompare(String(bLabel));
}

/**
 * Which priority tier does an advertisable row sit in, and is it in its window yet?
 */
function priorityOf(row, settings) {
  const lead = (value, fallback) => {
    if (value == null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  if (row?.is_vacant) {
    return row.gap_ok
      ? { tier: PRIORITY_VACANT, advertisable: true, reason: 'vacant' }
      : { tier: PRIORITY_VACANT, advertisable: false, reason: 'gap_too_short' };
  }
  if (row?.days_left == null || !Number.isFinite(Number(row.days_left))) {
    return {
      tier: Number(row?.contract_type) === 3 ? PRIORITY_NR : PRIORITY_OTHER,
      advertisable: false,
      reason: 'no_end_date',
    };
  }
  if (Number(row.contract_type) === 3) {
    const advertisable = Number(row.days_left) <= lead(settings?.lead_days_nr, 60);
    return { tier: PRIORITY_NR, advertisable, reason: advertisable ? 'nr' : 'outside_nr_lead' };
  }
  const advertisable = Number(row.days_left) <= lead(settings?.lead_days_other, 45);
  return { tier: PRIORITY_OTHER, advertisable, reason: advertisable ? 'other' : 'outside_other_lead' };
}

/** Sort a copy by tier, urgency within that tier, then property name. */
function sortByPriority(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const tierDifference = Number(a.tier) - Number(b.tier);
    if (tierDifference) return tierDifference;
    const aDays = a.days_left == null ? Number.POSITIVE_INFINITY : Number(a.days_left);
    const bDays = b.days_left == null ? Number.POSITIVE_INFINITY : Number(b.days_left);
    if (aDays !== bDays) return aDays - bDays;
    return String(a.property_name || '').localeCompare(String(b.property_name || ''));
  });
}

/**
 * Assign ordered vacancy bundles to ordered schedule slots, recycling spare
 * slots without repeating a property/forum pair in the same plan.
 */
function assignBundlesToSlots(bundles, slots, { tierOf } = {}) {
  const orderedBundles = Array.isArray(bundles) ? bundles : [];
  const orderedSlots = Array.isArray(slots) ? slots : [];
  const assignments = [];
  const firstPassCount = Math.min(orderedBundles.length, orderedSlots.length);
  const postingCounts = orderedBundles.map(() => 0);
  const forumsByProperty = new Map();
  const propertyKey = (bundle, index) => String(bundle?.property_id ?? bundle?.key ?? `bundle:${index}`);
  const forumKey = slot => String(slot?.forum?.forum_id ?? '');

  const record = (slot, bundle, bundleIndex, extra) => {
    assignments.push({ slot, bundle, extra });
    postingCounts[bundleIndex] += 1;
    const key = propertyKey(bundle, bundleIndex);
    if (!forumsByProperty.has(key)) forumsByProperty.set(key, new Set());
    forumsByProperty.get(key).add(forumKey(slot));
  };

  for (let i = 0; i < firstPassCount; i++) record(orderedSlots[i], orderedBundles[i], i, false);

  const overflow = orderedBundles.slice(orderedSlots.length);
  const unfilled = [];
  for (let slotIndex = firstPassCount; slotIndex < orderedSlots.length; slotIndex++) {
    const slot = orderedSlots[slotIndex];
    const forum = forumKey(slot);
    let selected = -1;
    for (let i = 0; i < orderedBundles.length; i++) {
      const usedForums = forumsByProperty.get(propertyKey(orderedBundles[i], i));
      if (usedForums?.has(forum)) continue;
      if (selected < 0) {
        selected = i;
        continue;
      }
      const candidateTier = tierOf ? Number(tierOf(orderedBundles[i])) : 0;
      const selectedTier = tierOf ? Number(tierOf(orderedBundles[selected])) : 0;
      if (candidateTier < selectedTier
          || (candidateTier === selectedTier && postingCounts[i] < postingCounts[selected])) selected = i;
    }
    if (selected < 0) unfilled.push(slot);
    else record(slot, orderedBundles[selected], selected, true);
  }

  return { assignments, overflow, unfilled };
}

module.exports = {
  slotKey,
  slotLabel,
  findRepeatViolations,
  suggestReplacements,
  forumWeeklyLoad,
  gapIsAdvertisable,
  PRIORITY_VACANT,
  PRIORITY_NR,
  PRIORITY_OTHER,
  vacancyToPublicShape,
  manualVacancyToRow,
  overrideAppliesTo,
  leaseChangedForOverride,
  pickVacancyRow,
  hasActiveManualVacancyOverride,
  classifyFreeOn,
  matchesFreeOn,
  formatLocalDate,
  vacancyFit,
  exceedsHardGapCap,
  vacancyNoMatchReason,
  partnerForwardBlock,
  compareVacancyFit,
  resolveAvailabilityWindows,
  priorityOf,
  sortByPriority,
  assignBundlesToSlots,
};

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

function addOneLocalDay(value) {
  const date = formatLocalDate(value);
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + 1);
  return formatLocalDate(d);
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
  const availableFrom = tier === PRIORITY_VACANT ? null : addOneLocalDay(endDate);
  const certaintyByTier = tier === PRIORITY_VACANT || tier === PRIORITY_NR;
  // `certain: false` is what TaneChat branches on: offer the unit only with the
  // caveat wording, because an MR/MTM/UC tenant may renew and the unit may never
  // become free.
  const certain = tier === PRIORITY_VACANT ? true : Boolean(certaintyByTier && endDate);

  return {
    unit_id: row?.unit_id == null ? null : String(row.unit_id),
    unit_name: row?.unit_name ?? null,
    property_id: row?.property_id == null ? null : String(row.property_id),
    property_name: row?.property_name ?? null,
    label: [row?.property_name, row?.unit_name].filter(Boolean).join(' ') || null,
    unit_type: row?.unit_type ?? null,
    beds: row?.beds != null ? Number(row.beds) : null,
    baths: row?.baths != null ? Number(row.baths) : null,
    size: row?.size != null ? Number(row.size) : null,
    rent: moneyString(row?.rent),
    tier,
    tier_name: tierName(tier),
    intent: row?.intent ?? null,
    availability: {
      status: tier === PRIORITY_VACANT ? 'now' : 'from_date',
      available_from: availableFrom,
      days_until: tier === PRIORITY_VACANT ? 0 : (row?.days_left != null ? Number(row.days_left) : null),
      certain,
    },
  };
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
function vacancyNoMatchReason(returnedCount, hiddenByGapCap) {
  if (Number(returnedCount) > 0) return null;
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
  formatLocalDate,
  vacancyFit,
  exceedsHardGapCap,
  vacancyNoMatchReason,
  partnerForwardBlock,
  compareVacancyFit,
  priorityOf,
  sortByPriority,
  assignBundlesToSlots,
};

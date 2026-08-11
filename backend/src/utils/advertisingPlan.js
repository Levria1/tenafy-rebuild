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
  priorityOf,
  sortByPriority,
  assignBundlesToSlots,
};

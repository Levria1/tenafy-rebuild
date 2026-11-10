const test = require('node:test');
const assert = require('node:assert/strict');
const {
  slotKey,
  slotLabel,
  findRepeatViolations,
  suggestReplacements,
  forumWeeklyLoad,
  gapIsAdvertisable,
  PAGE_WINDOW_MAX_DAYS,
  resolvePageExpiringWindow,
  priorityOf,
  sortByPriority,
  assignBundlesToSlots,
} = require('../src/utils/advertisingPlan');

const FORUMS = {
  NFR: { forum_id: 'NFR', forum_name: 'No Fee Rental', is_owned: 1, max_per_week: null, accounts: [{ id: 'P', email: 'parcellesignature@gmail.com' }, { id: 'B', email: 'bookings@taneresidence.com' }, { id: 'A', email: 'acjairbnb@gmail.com' }, { id: 'T4', email: 'taneresidence4@gmail.com' }, { id: 'J', email: 'tane.joanne@gmail.com' }] },
  FAR: { forum_id: 'FAR', forum_name: 'Find A Room In Hong Kong', is_owned: 1, max_per_week: null, accounts: [{ id: 'J', email: 'tane.joanne@gmail.com' }, { id: 'T6', email: 'taneresidence6@gmail.com' }] },
  STR: { forum_id: 'STR', forum_name: 'Hong Kong Apartments - Short term Rentals', is_owned: 1, max_per_week: null, accounts: [{ id: 'J', email: 'tane.joanne@gmail.com' }, { id: 'T6', email: 'taneresidence6@gmail.com' }, { id: 'A', email: 'acjairbnb@gmail.com' }, { id: 'T4', email: 'taneresidence4@gmail.com' }] },
  HKS: { forum_id: 'HKS', forum_name: 'Hong Kong Apartment For Rent & Sale 香港樓宇租售', is_owned: 0, max_per_week: null, accounts: [{ id: 'T6', email: 'taneresidence6@gmail.com' }, { id: 'A', email: 'acjairbnb@gmail.com' }, { id: 'B', email: 'bookings@taneresidence.com' }, { id: 'T4', email: 'taneresidence4@gmail.com' }] },
  NAF: { forum_id: 'NAF', forum_name: 'No Agent fee / Direct listings of flat / apartment in Hong Kong', is_owned: 0, max_per_week: null, accounts: [{ id: 'T4', email: 'taneresidence4@gmail.com' }, { id: 'T6', email: 'taneresidence6@gmail.com' }, { id: 'J', email: 'tane.joanne@gmail.com' }, { id: 'P', email: 'parcellesignature@gmail.com' }] },
  HKR: { forum_id: 'HKR', forum_name: 'HK Apartment for Rent', is_owned: 0, max_per_week: null, accounts: [{ id: 'T4', email: 'taneresidence4@gmail.com' }] },
  HKP: { forum_id: 'HKP', forum_name: '香港免佣樓房舖 自助租售-資訊提供HKproperty', is_owned: 0, max_per_week: null, accounts: [{ id: 'J', email: 'tane.joanne@gmail.com' }, { id: 'T4', email: 'taneresidence4@gmail.com' }] },
  HLA: { forum_id: 'HLA', forum_name: 'Hong Kong - Houses, land, apartments for Rent or Sale', is_owned: 0, max_per_week: null, accounts: [{ id: 'J', email: 'tane.joanne@gmail.com' }, { id: 'A', email: 'acjairbnb@gmail.com' }] },
  ARR: { forum_id: 'ARR', forum_name: 'Apartments & Rooms for Rent Hong Kong', is_owned: 0, max_per_week: null, accounts: [{ id: 'A', email: 'acjairbnb@gmail.com' }] },
  AFS: { forum_id: 'AFS', forum_name: 'Hong Kong Apartment and Flats for Sale and Rent', is_owned: 0, max_per_week: null, accounts: [{ id: 'T6', email: 'taneresidence6@gmail.com' }] },
  MKT: { forum_id: 'MKT', forum_name: 'Market Place', is_owned: 0, max_per_week: null, accounts: [{ id: 'T4', email: 'taneresidence4@gmail.com' }] },
};

const byDay = [
  { weekday: 1, rows: ['Prop1 FAR J', 'Prop2 NFR P', 'Prop3 HKS T6', 'Prop4 NAF T4', 'Prop5 HKS A', 'Prop6 HLA J', 'Prop7 NFR B'] },
  { weekday: 2, rows: ['Prop8 STR J', 'Prop9 NFR B', 'Prop10 FAR T6', 'Prop11 HKR T4', 'Prop12 NFR A', 'Urgent1 HKP J', 'Urgent2 HKS B'] },
  { weekday: 3, rows: ['Prop1 FAR J', 'Prop2 NFR B', 'Prop3 STR T6', 'Prop4 HKR T4', 'Prop5 HKP T4', 'Prop6 NAF T6', 'Prop7 NFR A'] },
  { weekday: 4, rows: ['Prop13 STR A', 'Prop14 NFR T4', 'Prop15 FAR T6', 'Prop8 NAF J', 'Prop9 NFR B', 'Urgent1 MKT T4', 'Urgent2 HKS A'] },
  { weekday: 5, rows: ['Prop1 HKS T4', 'Prop2 STR J', 'Prop3 NFR P', 'Prop4 NFR J', 'Prop10 FAR T6', 'Prop11 ARR A', 'Prop12 HKS B', 'Prop13 STR T4', 'Prop14 NAF T6', 'Prop15 NFR B'] },
  { weekday: 6, rows: ['Prop5 NFR J', 'Prop6 STR T6', 'Prop7 NFR P', 'Prop8 HKS T4', 'Prop9 AFS T6', 'Urgent1 NAF P', 'Urgent2 HLA A'] },
  { weekday: 0, rows: ['Prop16 FAR T6', 'Prop17 NFR B', 'Prop18 STR A', 'Prop19 MKT T4', 'Prop20 AFS T6', 'Urgent1 ARR A', 'Urgent2 NFR T4'] },
];

function rowFrom(entry, weekday, position) {
  const [slot, forumId, accountId] = entry.split(/\s+/);
  const m = slot.match(/^(Prop|Urgent)(\d+)$/);
  const forum = FORUMS[forumId];
  return {
    weekday,
    slot_kind: m[1].toLowerCase(),
    slot_no: Number(m[2]),
    position,
    forum_id: forum.forum_id,
    forum_name: forum.forum_name,
    account_id: accountId,
    is_owned: forum.is_owned,
    max_per_week: forum.max_per_week,
  };
}

const realRows = byDay.flatMap(day => day.rows.map((entry, i) => rowFrom(entry, day.weekday, i + 1)));
const forums = Object.values(FORUMS);

test('slotKey and slotLabel handle prop and urgent slots', () => {
  assert.equal(slotKey({ slot_kind: 'prop', slot_no: 7 }), 'prop:7');
  assert.equal(slotLabel({ slot_kind: 'prop', slot_no: 7 }), 'Prop 7');
  assert.equal(slotKey({ slot_kind: 'urgent', slot_no: 2 }), 'urgent:2');
  assert.equal(slotLabel({ slot_kind: 'urgent', slot_no: 2 }), 'Urgent 2');
});

test('findRepeatViolations finds the seven real seeded repeats', () => {
  const violations = findRepeatViolations(realRows);
  // These are real operator-sheet repeats and are deliberately seeded unfixed.
  assert.equal(violations.length, 7);
  assert.deepEqual(
    violations.map(v => [v.slot_label, v.forum_name, v.count]),
    [
      ['Prop 7', 'No Fee Rental', 3],
      ['Urgent 2', 'Hong Kong Apartment For Rent & Sale 香港樓宇租售', 2],
      ['Prop 1', 'Find A Room In Hong Kong', 2],
      ['Prop 2', 'No Fee Rental', 2],
      ['Prop 9', 'No Fee Rental', 2],
      ['Prop 10', 'Find A Room In Hong Kong', 2],
      ['Prop 13', 'Hong Kong Apartments - Short term Rentals', 2],
    ]
  );
});

test('repeat sorting puts highest count first and external before owned', () => {
  const labels = findRepeatViolations(realRows).map(v => v.slot_label);
  assert.equal(labels[0], 'Prop 7');
  assert.equal(labels[1], 'Urgent 2');
});

test('a slot using three different groups has no violation', () => {
  const rows = [
    { weekday: 1, slot_kind: 'prop', slot_no: 1, forum_id: 'A', forum_name: 'A' },
    { weekday: 2, slot_kind: 'prop', slot_no: 1, forum_id: 'B', forum_name: 'B' },
    { weekday: 3, slot_kind: 'prop', slot_no: 1, forum_id: 'C', forum_name: 'C' },
  ];
  assert.deepEqual(findRepeatViolations(rows), []);
});

test('findRepeatViolations reports weekdays for the repeat', () => {
  const prop7 = findRepeatViolations(realRows).find(v => v.slot_label === 'Prop 7');
  assert.deepEqual(prop7.weekdays, [1, 3, 6]);
});

test('suggestReplacements never suggests a group the slot already uses', () => {
  const violation = findRepeatViolations(realRows).find(v => v.slot_label === 'Prop 7');
  const suggestions = suggestReplacements(violation, realRows, forums);
  assert(!suggestions.some(s => s.forum_id === 'NFR'));
});

test('suggestReplacements prefers owned groups then least-loaded external groups', () => {
  const rows = [
    { weekday: 1, slot_kind: 'prop', slot_no: 1, forum_id: 'USED', forum_name: 'Used' },
    { weekday: 2, slot_kind: 'prop', slot_no: 1, forum_id: 'USED', forum_name: 'Used' },
    { weekday: 3, slot_kind: 'prop', slot_no: 2, forum_id: 'EXT2', forum_name: 'External Two' },
    { weekday: 4, slot_kind: 'prop', slot_no: 3, forum_id: 'EXT2', forum_name: 'External Two' },
    { weekday: 5, slot_kind: 'prop', slot_no: 4, forum_id: 'EXT1', forum_name: 'External One' },
  ];
  const localForums = [
    { forum_id: 'USED', forum_name: 'Used', is_owned: 0, accounts: [{ id: 'u', email: 'u@example.com' }] },
    { forum_id: 'OWN', forum_name: 'Owned', is_owned: 1, accounts: [{ id: 'o', email: 'o@example.com' }] },
    { forum_id: 'EXT2', forum_name: 'External Two', is_owned: 0, accounts: [{ id: 'e2', email: 'e2@example.com' }] },
    { forum_id: 'EXT1', forum_name: 'External One', is_owned: 0, accounts: [{ id: 'e1', email: 'e1@example.com' }] },
  ];
  const suggestions = suggestReplacements(findRepeatViolations(rows)[0], rows, localForums);
  assert.deepEqual(suggestions.map(s => s.forum_id), ['OWN', 'EXT1', 'EXT2']);
});

test('suggestReplacements skips forums with no member accounts', () => {
  const violation = findRepeatViolations(realRows).find(v => v.slot_label === 'Prop 7');
  const suggestions = suggestReplacements(violation, realRows, [
    ...forums,
    { forum_id: 'EMPTY', forum_name: 'Empty Forum', is_owned: 1, accounts: [] },
  ]);
  assert(!suggestions.some(s => s.forum_id === 'EMPTY'));
});

test('forumWeeklyLoad counts the sheet and evaluates caps', () => {
  const cappedForums = forums.map(f => {
    if (f.forum_id === 'HKS') return { ...f, max_per_week: 6 };
    if (f.forum_id === 'NAF') return { ...f, max_per_week: 5 };
    if (f.forum_id === 'NFR') return { ...f, max_per_week: 1 };
    return f;
  });
  const totals = forumWeeklyLoad(realRows, cappedForums);
  const byId = Object.fromEntries(totals.map(f => [f.forum_id, f]));
  assert.equal(byId.NFR.count, 15);
  assert.equal(byId.FAR.count, 6);
  assert.equal(byId.STR.count, 7);
  assert.equal(byId.HKS.count, 7);
  assert.equal(byId.NAF.count, 5);
  assert.equal(byId.HKS.over_cap, true);
  assert.equal(byId.NAF.over_cap, false);
  assert.equal(byId.NFR.over_cap, false);
  assert.equal(byId.AFS.over_cap, false);
});

test('empty inputs return empty arrays', () => {
  assert.deepEqual(findRepeatViolations([]), []);
  assert.deepEqual(suggestReplacements(null, [], []), []);
  assert.deepEqual(forumWeeklyLoad([], []), []);
});

test('gapIsAdvertisable accepts units with no next lease', () => {
  assert.equal(gapIsAdvertisable(null, 40), true);
  assert.equal(gapIsAdvertisable(undefined, 40), true);
});

test('gapIsAdvertisable applies the configured threshold inclusively', () => {
  assert.equal(gapIsAdvertisable(40, 40), true);
  assert.equal(gapIsAdvertisable(39, 40), false);
  assert.equal(gapIsAdvertisable(41, 40), true);
});

test('gapIsAdvertisable rejects the four real short vacancy gaps', () => {
  // These are the actual units; all four are currently advertised despite being taken.
  for (const days of [2, 6, 18, 21]) assert.equal(gapIsAdvertisable(days, 40), false);
});

test('gapIsAdvertisable rejects move-ins today, in the past, or invalid data', () => {
  assert.equal(gapIsAdvertisable(0, 40), false);
  assert.equal(gapIsAdvertisable(-3, 40), false);
  assert.equal(gapIsAdvertisable('soon', 40), false);
});

test('gapIsAdvertisable defaults an invalid minimum to 40', () => {
  assert.equal(gapIsAdvertisable(39, null), false);
  assert.equal(gapIsAdvertisable(40, Number.NaN), true);
});

test('resolvePageExpiringWindow uses the default for missing through dates', () => {
  for (const throughDate of [null, undefined, '']) {
    const days = resolvePageExpiringWindow(throughDate, '2026-08-18', 60);
    assert.equal(days, 60);
    assert.equal(Number.isInteger(days), true);
  }
});

test('resolvePageExpiringWindow ignores malformed through dates without throwing', () => {
  for (const throughDate of ['2026-13-01', 'oct', '2026-10-01; DROP', new Date('2026-10-01T00:00:00Z'), 20261001]) {
    const days = resolvePageExpiringWindow(throughDate, '2026-08-18', 60);
    assert.equal(days, 60);
    assert.equal(Number.isInteger(days), true);
  }
});

test('resolvePageExpiringWindow keeps the default on or before the default window end', () => {
  for (const throughDate of ['2026-08-18', '2026-09-01', '2026-10-17']) {
    const days = resolvePageExpiringWindow(throughDate, '2026-08-18', 60);
    assert.equal(days, 60);
    assert.equal(Number.isInteger(days), true);
  }
});

test('resolvePageExpiringWindow widens to the requested through date beyond the default', () => {
  const days = resolvePageExpiringWindow('2026-10-31', '2026-08-18', 60);
  assert.equal(days, 74);
  assert.equal(Number.isInteger(days), true);
});

test('resolvePageExpiringWindow clamps requests beyond the page maximum', () => {
  const days = resolvePageExpiringWindow('2028-10-31', '2026-08-18', 60);
  assert.equal(days, PAGE_WINDOW_MAX_DAYS);
  assert.equal(Number.isInteger(days), true);
});

function bundle(id) {
  return { key: `bundle-${id}`, property_id: `property-${id}` };
}

function planSlot(id, forumId) {
  return { id: `slot-${id}`, slot_label: `Slot ${id}`, position: id, forum: { forum_id: forumId } };
}

test('assignBundlesToSlots assigns equal counts one-to-one', () => {
  const bundles = [bundle(1), bundle(2)];
  const slots = [planSlot(1, 'A'), planSlot(2, 'B')];
  const result = assignBundlesToSlots(bundles, slots);
  assert.deepEqual(result.assignments.map(a => [a.bundle.key, a.slot.id, a.extra]), [
    ['bundle-1', 'slot-1', false],
    ['bundle-2', 'slot-2', false],
  ]);
  assert.deepEqual(result.overflow, []);
  assert.deepEqual(result.unfilled, []);
});

test('assignBundlesToSlots puts bundles beyond slot count in overflow', () => {
  const bundles = [bundle(1), bundle(2), bundle(3)];
  const result = assignBundlesToSlots(bundles, [planSlot(1, 'A'), planSlot(2, 'B')]);
  assert.deepEqual(result.assignments.map(a => a.bundle.key), ['bundle-1', 'bundle-2']);
  assert.deepEqual(result.overflow, [bundles[2]]);
  assert.deepEqual(result.unfilled, []);
});

test('assignBundlesToSlots recycles spare slots across available bundles', () => {
  const result = assignBundlesToSlots(
    [bundle(1), bundle(2)],
    ['A', 'B', 'C', 'D', 'E'].map((forum, i) => planSlot(i + 1, forum))
  );
  assert.equal(result.assignments.length, 5);
  assert.equal(result.assignments.filter(a => a.extra).length, 3);
  assert.deepEqual(result.unfilled, []);
});

test('assignBundlesToSlots never repeats a property in the same forum', () => {
  const result = assignBundlesToSlots(
    [bundle(1)],
    [planSlot(1, 'A'), planSlot(2, 'A'), planSlot(3, 'B')]
  );
  assert.deepEqual(result.assignments.map(a => a.slot.id), ['slot-1', 'slot-3']);
  assert.deepEqual(result.unfilled.map(s => s.id), ['slot-2']);
  assert.equal(new Set(result.assignments.map(a => a.slot.forum.forum_id)).size, 2);
});

test('assignBundlesToSlots spreads extras evenly', () => {
  const result = assignBundlesToSlots(
    [bundle(1), bundle(2)],
    ['A', 'B', 'C', 'D'].map((forum, i) => planSlot(i + 1, forum))
  );
  const counts = result.assignments.reduce((out, a) => {
    out[a.bundle.key] = (out[a.bundle.key] || 0) + 1;
    return out;
  }, {});
  assert.deepEqual(counts, { 'bundle-1': 2, 'bundle-2': 2 });
});

test('assignBundlesToSlots is deterministic', () => {
  const bundles = [bundle(1), bundle(2)];
  const slots = ['A', 'B', 'C', 'D', 'E'].map((forum, i) => planSlot(i + 1, forum));
  assert.deepEqual(assignBundlesToSlots(bundles, slots), assignBundlesToSlots(bundles, slots));
});

test('assignBundlesToSlots handles empty bundles and empty slots', () => {
  const slots = [planSlot(1, 'A'), planSlot(2, 'B')];
  assert.deepEqual(assignBundlesToSlots([], slots), { assignments: [], overflow: [], unfilled: slots });
  const bundles = [bundle(1), bundle(2)];
  assert.deepEqual(assignBundlesToSlots(bundles, []), { assignments: [], overflow: bundles, unfilled: [] });
});

test('priorityOf accepts a vacant unit whose gap is long enough', () => {
  assert.deepEqual(priorityOf({ is_vacant: true, gap_ok: true }, {}),
    { tier: 1, advertisable: true, reason: 'vacant' });
});

test('priorityOf rejects a vacant unit whose gap is too short', () => {
  assert.deepEqual(priorityOf({ is_vacant: true, gap_ok: false }, {}),
    { tier: 1, advertisable: false, reason: 'gap_too_short' });
});

test('priorityOf applies the NR boundary inclusively', () => {
  assert.equal(priorityOf({ contract_type: 3, days_left: 60 }, {}).advertisable, true);
  assert.deepEqual(priorityOf({ contract_type: 3, days_left: 61 }, {}),
    { tier: 2, advertisable: false, reason: 'outside_nr_lead' });
  assert.equal(priorityOf({ contract_type: 3, days_left: 10 }, {}).advertisable, true);
});

test('priorityOf applies the MR boundary inclusively', () => {
  assert.equal(priorityOf({ contract_type: 1, days_left: 45 }, {}).advertisable, true);
  assert.deepEqual(priorityOf({ contract_type: 1, days_left: 46 }, {}),
    { tier: 3, advertisable: false, reason: 'outside_other_lead' });
});

test('priorityOf uses the OTHER window for MTM, UC, null, and unset intents', () => {
  for (const contract_type of [2, 4, null, undefined]) {
    assert.equal(priorityOf({ contract_type, days_left: 45 }, {}).advertisable, true);
    assert.equal(priorityOf({ contract_type, days_left: 46 }, {}).advertisable, false);
  }
});

test('priorityOf distinguishes a 55-day MR lease from a 55-day NR lease', () => {
  // Behaviour change: today both are advertised; now only confirmed NR is.
  assert.equal(priorityOf({ contract_type: 1, days_left: 55 }, {}).advertisable, false);
  assert.equal(priorityOf({ contract_type: 3, days_left: 55 }, {}).advertisable, true);
});

test('priorityOf rejects an expiring row without an end date', () => {
  assert.deepEqual(priorityOf({ contract_type: 3, days_left: null }, {}),
    { tier: 2, advertisable: false, reason: 'no_end_date' });
});

test('priorityOf falls back for missing or NaN lead settings', () => {
  assert.equal(priorityOf({ contract_type: 3, days_left: 60 }, { lead_days_nr: Number.NaN }).advertisable, true);
  assert.equal(priorityOf({ contract_type: 3, days_left: 61 }, {}).advertisable, false);
  assert.equal(priorityOf({ contract_type: 1, days_left: 45 }, { lead_days_other: Number.NaN }).advertisable, true);
  assert.equal(priorityOf({ contract_type: 1, days_left: 46 }, {}).advertisable, false);
});

test('sortByPriority puts tier ahead of urgency', () => {
  const rows = [
    { property_name: 'NR', tier: 2, days_left: 1 },
    { property_name: 'Vacant', tier: 1, days_left: 100 },
  ];
  assert.deepEqual(sortByPriority(rows).map(r => r.property_name), ['Vacant', 'NR']);
});

test('sortByPriority orders urgency within each tier', () => {
  const rows = [
    { property_name: 'V1', tier: 1, days_left: -2 },
    { property_name: 'V2', tier: 1, days_left: -20 },
    { property_name: 'N2', tier: 2, days_left: 20 },
    { property_name: 'N1', tier: 2, days_left: 2 },
    { property_name: 'O2', tier: 3, days_left: 30 },
    { property_name: 'O1', tier: 3, days_left: 3 },
  ];
  assert.deepEqual(sortByPriority(rows).map(r => r.property_name), ['V2', 'V1', 'N1', 'N2', 'O1', 'O2']);
});

test('sortByPriority does not mutate its input', () => {
  const rows = [{ property_name: 'Other', tier: 3, days_left: 1 }, { property_name: 'Vacant', tier: 1, days_left: -1 }];
  sortByPriority(rows);
  assert.deepEqual(rows.map(r => r.property_name), ['Other', 'Vacant']);
});

test('assignBundlesToSlots repeats one-unit bundles round-robin, vacant first in each round', () => {
  const bundles = [{ ...bundle(1), tier: 1 }, { ...bundle(2), tier: 3 }];
  const slots = ['A', 'B', 'C', 'D', 'E'].map((forum, i) => planSlot(i + 1, forum));
  const result = assignBundlesToSlots(bundles, slots, { tierOf: b => b.tier });
  // Owner, 2026-11-10: the vacant property no longer takes every spare slot.
  assert.deepEqual(result.assignments.map(a => a.bundle.tier), [1, 3, 1, 3, 1]);
});

function unit(id, tier, days_left) {
  return { unit_id: id, unit_name: id, tier, days_left };
}

test('assignBundlesToSlots fills spare slots with single-unit posts, empty units first', () => {
  // Today's live shape: Poplar has one empty unit and two expiring; FLT three expiring.
  const poplar = { key: 'poplar', property_id: 'P', tier: 1,
    units: [unit('1A', 1, -21), unit('1C', 3, 30), unit('5B', 3, 20)] };
  const flt = { key: 'flt', property_id: 'F', tier: 2,
    units: [unit('2I', 2, 25), unit('1G', 3, 35), unit('1F', 3, 42)] };
  const gilman = { key: 'gilman', property_id: 'G', tier: 3, units: [unit('G1', 3, 40)] };
  const holly = { key: 'holly', property_id: 'H', tier: 3, units: [unit('5A', 3, 40)] };
  const slots = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((forum, i) => planSlot(i + 1, forum));
  const result = assignBundlesToSlots([poplar, flt, gilman, holly], slots, { tierOf: b => b.tier });

  const extras = result.assignments.filter(a => a.extra);
  assert.deepEqual(extras.map(a => a.bundle.units.map(u => u.unit_id)), [['1A'], ['2I'], ['5B']]);
  assert.ok(extras.every(a => a.bundle.single_unit === true));
  // The single-unit post takes its own unit's tier, so the badge and log are right.
  assert.deepEqual(extras.map(a => a.bundle.tier), [1, 2, 3]);
  // The first pass is untouched: one combined post per property.
  assert.deepEqual(result.assignments.filter(a => !a.extra).map(a => a.bundle.key),
    ['poplar', 'flt', 'gilman', 'holly']);
  assert.deepEqual(result.unfilled, []);
});

test('assignBundlesToSlots posts every unit alone once before any unit twice', () => {
  const p = { key: 'p', property_id: 'P', tier: 1, units: [unit('1A', 1, -5), unit('1B', 3, 30)] };
  const slots = ['A', 'B', 'C', 'D'].map((forum, i) => planSlot(i + 1, forum));
  const result = assignBundlesToSlots([p], slots, { tierOf: b => b.tier });
  assert.deepEqual(result.assignments.filter(a => a.extra).map(a => a.bundle.units[0].unit_id),
    ['1A', '1B', '1A']);
});

test('assignBundlesToSlots never sends a split unit to a forum its property already used', () => {
  const p = { key: 'p', property_id: 'P', tier: 1, units: [unit('1A', 1, -5), unit('1B', 3, 30)] };
  const result = assignBundlesToSlots([p], [planSlot(1, 'A'), planSlot(2, 'A'), planSlot(3, 'B')],
    { tierOf: b => b.tier });
  assert.deepEqual(result.assignments.map(a => a.slot.id), ['slot-1', 'slot-3']);
  assert.deepEqual(result.unfilled.map(s => s.id), ['slot-2']);
});

test('assignBundlesToSlots does not mutate the bundles it splits', () => {
  const p = { key: 'p', property_id: 'P', tier: 1, units: [unit('1A', 1, -5), unit('1B', 3, 30)] };
  const before = JSON.stringify(p);
  assignBundlesToSlots([p], ['A', 'B', 'C'].map((f, i) => planSlot(i + 1, f)), { tierOf: b => b.tier });
  assert.equal(JSON.stringify(p), before);
});

test('assignBundlesToSlots retains count-first recycling without tierOf', () => {
  const result = assignBundlesToSlots(
    [bundle(1), bundle(2)],
    ['A', 'B', 'C', 'D'].map((forum, i) => planSlot(i + 1, forum))
  );
  assert.deepEqual(result.assignments.map(a => a.bundle.key), ['bundle-1', 'bundle-2', 'bundle-1', 'bundle-2']);
});

test('assignBundlesToSlots still avoids duplicate forums with tierOf', () => {
  const result = assignBundlesToSlots(
    [{ ...bundle(1), tier: 1 }],
    [planSlot(1, 'A'), planSlot(2, 'A'), planSlot(3, 'B')],
    { tierOf: b => b.tier }
  );
  assert.deepEqual(result.assignments.map(a => a.slot.id), ['slot-1', 'slot-3']);
  assert.deepEqual(result.unfilled.map(s => s.id), ['slot-2']);
});

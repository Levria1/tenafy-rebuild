const test = require('node:test');
const assert = require('node:assert');
const { applyPlaceholders, resolveUnitValues, PLACEHOLDER_TOKENS, computePostingRent, convertBold, parseBedSize, bedsLabel } = require('../src/services/advertisingTemplate');

test('bedsLabel: 0 → Studio, n → "n Bedroom", unknown → ""', () => {
  assert.equal(bedsLabel(0), 'Studio');
  assert.equal(bedsLabel(1), '1 Bedroom');
  assert.equal(bedsLabel(2), '2 Bedroom');
  assert.equal(bedsLabel('3'), '3 Bedroom');
  assert.equal(bedsLabel(null), '');
  assert.equal(bedsLabel(undefined), '');
  assert.equal(bedsLabel(''), '');
});

test('parseBedSize: extracts size class + width from the Mattress amenity name', () => {
  assert.equal(parseBedSize('Mattress (Double Size 1.2m)'), 'Double (mattress size)');
  assert.equal(parseBedSize('Mattress (Twin Size 0.9m)'), 'Twin (mattress size)');
  assert.equal(parseBedSize('Mattress (Queen Size 1.5m)'), 'Queen (mattress size)');
  assert.equal(parseBedSize('Mattress (King Size 2.0m)'), 'King (mattress size)');
  assert.equal(parseBedSize(''), '');            // none selected
  assert.equal(parseBedSize(null), '');
  assert.equal(parseBedSize(undefined), '');
  assert.equal(parseBedSize('Weird custom mattress'), 'Weird custom mattress'); // unparseable → as-is
});

test('resolveUnitValues: %BedSize% comes from the unit\'s Mattress amenity', async () => {
  const pool = {
    execute: async (sql) => {
      if (/FROM unit u JOIN property p/.test(sql)) {
        return [[{ unit_name: '105', property_name: 'Lai Yuen', beds: 0, baths: 1,
                   size: 150, size_unit: 'sqft', rent_price_min: 11000, rent_price_max: 13000 }]];
      }
      if (/unit_amenity ua JOIN amenity a/.test(sql)) {
        return [[{ name: 'Mattress (Double Size 1.2m)' }]];
      }
      return [[]];
    },
  };
  const values = await resolveUnitValues(pool, 'org', '105', {});
  assert.equal(values['%BedSize%'], 'Double (mattress size)');
});

test('convertBold: **marked** segments become Unicode bold, rest untouched', () => {
  assert.equal(convertBold('Unit: **2K**'), 'Unit: \u{1D7D0}\u{1D40A}');   // 𝟐𝐊
  assert.equal(convertBold('no marks here'), 'no marks here');
  assert.equal(convertBold('**a** and **B**'), '\u{1D41A} and \u{1D401}'); // 𝐚 and 𝐁
  assert.equal(convertBold(null), '');
  assert.equal(convertBold('keep (punct) **A!**'), 'keep (punct) \u{1D400}!'); // punctuation inside stays literal
});

test('computePostingRent: top of range until the unit is actually empty', () => {
  // Set by the owner on 11 Sep 2026. The old ladder (high 56d+, mid 42-55d, low
  // below, -10% once vacant) had a top rung nothing could reach: a unit only joins
  // the roster at 60 days out (NR) or 45 (everything else), so `high` needed more
  // notice than the roster ever gave. Every one of the six units on the roster that
  // day sat at low, mid or discount.
  const [min, max] = [5000, 8000];
  assert.deepEqual(computePostingRent(min, max, 70), { amount: 8000, tier: 'high' });
  assert.deepEqual(computePostingRent(min, max, 56), { amount: 8000, tier: 'high' });
  assert.deepEqual(computePostingRent(min, max, 50), { amount: 8000, tier: 'high' }); // was mid
  assert.deepEqual(computePostingRent(min, max, 35), { amount: 8000, tier: 'high' }); // was low
  assert.deepEqual(computePostingRent(min, max, 1),  { amount: 8000, tier: 'high' });
  assert.deepEqual(computePostingRent(min, max, 0),  { amount: 8000, tier: 'high' }); // free today
});

test('computePostingRent: a unit standing empty drops to the midpoint, and no lower', () => {
  const [min, max] = [5000, 8000];
  assert.deepEqual(computePostingRent(min, max, -1), { amount: 6500, tier: 'mid' });
  assert.deepEqual(computePostingRent(min, max, -5), { amount: 6500, tier: 'mid' });
  assert.deepEqual(computePostingRent(min, max, -90), { amount: 6500, tier: 'mid' });
  // The bottom of the range and the 10%-under discount are both retired: nothing
  // advertises below the midpoint any more.
  for (const d of [70, 0, -1, -90, null]) {
    const t = computePostingRent(min, max, d).tier;
    assert.ok(t === 'high' || t === 'mid', `tier ${t} should no longer occur`);
  }
});

test('computePostingRent: single value (min==max) and missing bounds', () => {
  assert.deepEqual(computePostingRent(5500, 5500, 70), { amount: 5500, tier: 'high' });
  assert.deepEqual(computePostingRent(5500, null, 70), { amount: 5500, tier: 'high' }); // only min
  assert.deepEqual(computePostingRent(null, 6000, 30), { amount: 6000, tier: 'high' }); // only max → hi=max
  assert.equal(computePostingRent(null, null, 30), null);                                // no range
  // Unknown days reads as not-yet-vacant: an empty unit always has a date behind it.
  assert.deepEqual(computePostingRent(5000, 8000, null), { amount: 8000, tier: 'high' });
});

test('applyPlaceholders substitutes known tokens', () => {
  const out = applyPlaceholders('%UnitName% at %PropertyName% — %Rent%', {
    '%UnitName%': '2B', '%PropertyName%': 'Poplar', '%Rent%': 'HK$13,000',
  });
  assert.equal(out, '2B at Poplar — HK$13,000');
});

test('applyPlaceholders leaves UNKNOWN tokens untouched (typo visible)', () => {
  const out = applyPlaceholders('%UnitName% %Nope%', { '%UnitName%': '2B' });
  assert.equal(out, '2B %Nope%');
});

test('applyPlaceholders replaces a null/missing value with empty string', () => {
  const out = applyPlaceholders('[%Beds%] beds', { '%Beds%': null });
  assert.equal(out, '[] beds');
});

test('applyPlaceholders handles null/undefined text', () => {
  assert.equal(applyPlaceholders(null), '');
  assert.equal(applyPlaceholders(undefined), '');
});

test('applyPlaceholders replaces every occurrence of a repeated token', () => {
  const out = applyPlaceholders('%UnitName%/%UnitName%', { '%UnitName%': 'A' });
  assert.equal(out, 'A/A');
});

test('resolveUnitValues builds a full token map (rent range + available date)', async () => {
  // Fake pool: switch on the SQL to return canned rows.
  const pool = {
    execute: async (sql) => {
      if (/FROM unit u JOIN property p/.test(sql)) {
        return [[{
          unit_name: '2B', unit_type: 'apartment', beds: 2, baths: 1,
          size: 500, size_unit: 'ft²', rent_price_min: 13000, rent_price_max: 15000,
          deposit_price: 26000, property_name: 'Poplar', street_address: '1 Main St',
          district: 'Central', city: 'HK',
        }]];
      }
      // current lease lookup → occupied, ends 2026-09-30
      // Matched loosely on shape: the 'today' term is now an inlined Hong Kong
      // date literal rather than CURDATE(), and this fake must not care which.
      if (/start_date <= \S+ AND \(end_date IS NULL OR end_date >= \S+\)/.test(sql)) {
        return [[{ d: '2026-09-30' }]];
      }
      return [[]];
    },
  };
  const values = await resolveUnitValues(pool, '8300127259922432', '999', { webpage_link: 'https://x.com/2b' });
  assert.equal(values['%UnitName%'], '2B');
  assert.equal(values['%PropertyName%'], 'Poplar');
  assert.equal(values['%Beds%'], '2');
  assert.equal(values['%Size%'], '500 ft²');
  assert.equal(values['%Rent%'], 'HK$13,000 - HK$15,000');  // range because min≠max
  assert.equal(values['%Deposit%'], 'HK$26,000');
  assert.equal(values['%AvailableDate%'], '2026-09-30');    // current lease end
  assert.equal(values['%WebpageLink%'], 'https://x.com/2b');
  // every known token must be present in the map
  for (const tok of PLACEHOLDER_TOKENS) assert.ok(tok in values, `missing ${tok}`);
});

test('resolveUnitValues: occupied unit on an OPEN-ENDED lease → blank AvailableDate, no past-lease fallback', async () => {
  let pastQueried = false;
  const pool = {
    execute: async (sql) => {
      if (/FROM unit u JOIN property p/.test(sql)) {
        return [[{ unit_name: '3A', property_name: 'Mercer', beds: 1, baths: 1,
                   rent_price_min: 10000, rent_price_max: 10000, deposit_price: 20000 }]];
      }
      // current lease EXISTS but end_date is NULL (month-to-month) → d: null
      // Matched loosely on shape: the 'today' term is now an inlined Hong Kong
      // date literal rather than CURDATE(), and this fake must not care which.
      if (/start_date <= \S+ AND \(end_date IS NULL OR end_date >= \S+\)/.test(sql)) {
        return [[{ d: null }]];
      }
      // past-lease fallback — must NOT be reached
      if (/MAX\(end_date\)/.test(sql)) { pastQueried = true; return [[{ d: '2020-01-01' }]]; }
      return [[]];
    },
  };
  const values = await resolveUnitValues(pool, 'org', '1', {});
  assert.equal(values['%AvailableDate%'], '', 'open-ended occupied → blank, not a past date');
  assert.equal(pastQueried, false, 'must not fall back to the last-ended lease when currently occupied');
});

test('resolveUnitValues returns null when the unit is not found', async () => {
  const pool = { execute: async () => [[]] };
  const values = await resolveUnitValues(pool, 'org', 'missing', {});
  assert.equal(values, null);
});

// ---------------------------------------------------------------------------
// Availability vs a follow-on lease.
//
// A handover postpones the advertised date until the connected leases end.
// Dates and day counts below are SQL results, independent of the test clock.
function poolWithFollowOn(endsOn, leases = []) {
  return {
    execute: async (sql, params) => {
      if (/FROM unit u JOIN property p/.test(sql)) {
        return [[{ unit_name: '3D', property_name: 'Mong Kok', beds: 0, baths: 1,
                   size: 160, size_unit: 'sqft', rent_price_min: 8500, rent_price_max: 9900 }]];
      }
      if (/start_date <= \S+ AND \(end_date IS NULL OR end_date >= \S+\)/.test(sql)) {
        return [[{ d: endsOn, days_to_end: 28 }]];
      }
      if (/AS starts_on/.test(sql)) {
        assert.deepEqual(params, ['3D', endsOn]);
        assert.match(sql, /DATEDIFF\(end_date, /);
        assert.match(sql, /ORDER BY start_date ASC/);
        return [leases];
      }
      return [[]];
    },
  };
}

test('AvailableDate: same-day handover uses the second lease end', async () => {
  const values = await resolveUnitValues(poolWithFollowOn('2026-11-11', [
    { starts_on: '2026-11-11', ends_on: '2026-12-15', days_to_end: 38 },
  ]), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], '2026-12-15');
  assert.deepEqual(values.__availability, { date: '2026-12-15', relet_from: null, taken: false });
});

test('AvailableDate: three leases extend through overlaps and report the later gap', async () => {
  const values = await resolveUnitValues(poolWithFollowOn('2026-11-11', [
    { starts_on: '2026-11-11', ends_on: '2026-12-15', days_to_end: 38 },
    { starts_on: '2026-12-10', ends_on: '2027-01-15', days_to_end: 69 },
    { starts_on: '2027-02-01', ends_on: null },
  ]), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], '2027-01-15');
  assert.deepEqual(values.__availability, { date: '2027-01-15', relet_from: '2027-02-01', taken: false });
});

test('AvailableDate: chain ending open-ended is taken', async () => {
  const values = await resolveUnitValues(poolWithFollowOn('2026-11-11', [
    { starts_on: '2026-11-11', ends_on: '2026-12-15', days_to_end: 38 },
    { starts_on: '2026-12-15', ends_on: null },
  ]), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], '');
  assert.deepEqual(values.__availability, { date: null, relet_from: null, taken: true });
});

test('AvailableDate: shorter overlaps do not extend the chain; final SQL days drive rent', async () => {
  const values = await resolveUnitValues(poolWithFollowOn('2026-11-11', [
    { starts_on: '2026-11-10', ends_on: '2026-12-15', days_to_end: 0 },
    { starts_on: '2026-11-12', ends_on: '2026-11-20', days_to_end: -1 },
  ]), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], 'Now');
  assert.equal(values.__availability.date, '2026-12-15');
  assert.equal(values.__availability.taken, false);
  assert.equal(values['%PostingRentAmount%'], '9,900');
});

test('AvailableDate: a genuine gap keeps its date', async () => {
  // Free from 30 Sep until 1 Dec. That is a real window, and whether it is long
  // enough to advertise is min_gap_days' call upstream, not the renderer's.
  const values = await resolveUnitValues(poolWithFollowOn('2026-09-30', [{ starts_on: '2026-12-01', ends_on: '2027-01-01' }]), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], '2026-09-30');
  assert.equal(values.__availability.taken, false);
  assert.equal(values.__availability.relet_from, '2026-12-01');
  assert.equal(values.__availability.date, '2026-09-30');
});

test('AvailableDate: no follow-on lease leaves the old behaviour untouched', async () => {
  const values = await resolveUnitValues(poolWithFollowOn('2026-11-01'), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], '2026-11-01');
  assert.equal(values.__availability.taken, false);
  assert.equal(values.__availability.relet_from, null);
});

test('AvailableDate: an open-ended current lease never runs the follow-on query', async () => {
  // No end date means no handover date to contradict, and the query below takes
  // that end date as a parameter — running it with null would match every lease.
  let followOnQueried = false;
  const pool = {
    execute: async (sql) => {
      if (/FROM unit u JOIN property p/.test(sql)) {
        return [[{ unit_name: '4A', property_name: 'Mercer', beds: 1, baths: 1 }]];
      }
      if (/start_date <= \S+ AND \(end_date IS NULL OR end_date >= \S+\)/.test(sql)) return [[{ d: null }]];
      if (/AS starts_on/.test(sql)) { followOnQueried = true; return [[{ next_start: '2026-01-01' }]]; }
      return [[]];
    },
  };
  const values = await resolveUnitValues(pool, 'org', '4A', {});
  assert.equal(values['%AvailableDate%'], '');
  assert.equal(followOnQueried, false, 'must not query follow-ons with a null end date');
  // Unchanged behaviour: no date to contradict, so the post is not refused.
  assert.equal(values.__availability.taken, false);
});

test('__availability never reaches ad text', async () => {
  // applyPlaceholders substitutes only TOKEN_SET keys, so the piggybacked field
  // cannot leak into a Facebook post even if a template names it.
  const values = await resolveUnitValues(poolWithFollowOn('2026-09-30', [{ starts_on: '2026-09-30', ends_on: null }]), 'org', '3D', {});
  const line = applyPlaceholders('%UnitName%: available %AvailableDate% __availability', values);
  assert.equal(line, '3D: available  __availability');
});


test('AvailableDate: an excessive chain prints no date and refuses the post', async () => {
  const leases = Array.from({ length: 13 }, (_, i) => ({
    starts_on: `2026-11-${String(i + 1).padStart(2, '0')}`,
    ends_on: `2026-11-${String(i + 2).padStart(2, '0')}`,
    days_to_end: i + 2,
  }));
  // A partial end date would be a lie, and throwing would fail the whole plan.
  const values = await resolveUnitValues(poolWithFollowOn('2026-11-01', leases), 'org', '3D', {});
  assert.equal(values['%AvailableDate%'], '');
  assert.deepEqual(values.__availability, { date: null, relet_from: null, taken: true });
});

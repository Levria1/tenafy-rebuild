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

test('computePostingRent: tiers step down as availability nears', () => {
  const min = 5000, max = 8000;
  assert.deepEqual(computePostingRent(min, max, 70), { amount: 8000, tier: 'high' });    // >8wk → high
  assert.deepEqual(computePostingRent(min, max, 56), { amount: 8000, tier: 'high' });    // exactly 8wk
  assert.deepEqual(computePostingRent(min, max, 50), { amount: 6500, tier: 'mid' });     // 6–8wk → mid (midpoint)
  assert.deepEqual(computePostingRent(min, max, 42), { amount: 6500, tier: 'mid' });     // exactly 6wk
  assert.deepEqual(computePostingRent(min, max, 30), { amount: 5000, tier: 'low' });     // <6wk → low
  assert.deepEqual(computePostingRent(min, max, 21), { amount: 5000, tier: 'low' });     // 3wk → low
  assert.deepEqual(computePostingRent(min, max, 0),  { amount: 5000, tier: 'low' });     // due today
  assert.deepEqual(computePostingRent(min, max, -1), { amount: 5000, tier: 'low' });     // vacant ≤1 day → no discount
  assert.deepEqual(computePostingRent(min, max, -5), { amount: 4500, tier: 'discount' });// vacant >1 day → low−10%
});

test('computePostingRent: single value (min==max) and missing bounds', () => {
  assert.deepEqual(computePostingRent(5500, 5500, 70), { amount: 5500, tier: 'high' });
  assert.deepEqual(computePostingRent(5500, null, 70), { amount: 5500, tier: 'high' }); // only min
  assert.deepEqual(computePostingRent(null, 6000, 30), { amount: 6000, tier: 'low' });  // only max → lo=max
  assert.equal(computePostingRent(null, null, 30), null);                                // no range
  assert.deepEqual(computePostingRent(5000, 8000, null), { amount: 5000, tier: 'low' }); // unknown days → conservative
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

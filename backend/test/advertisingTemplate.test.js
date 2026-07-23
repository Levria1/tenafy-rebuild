const test = require('node:test');
const assert = require('node:assert');
const { applyPlaceholders, resolveUnitValues, PLACEHOLDER_TOKENS } = require('../src/services/advertisingTemplate');

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
      if (/start_date <= CURDATE\(\) AND \(end_date IS NULL OR end_date >= CURDATE\(\)\)/.test(sql)) {
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

test('resolveUnitValues returns null when the unit is not found', async () => {
  const pool = { execute: async () => [[]] };
  const values = await resolveUnitValues(pool, 'org', 'missing', {});
  assert.equal(values, null);
});

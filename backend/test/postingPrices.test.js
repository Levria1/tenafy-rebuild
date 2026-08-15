const test = require('node:test');
const assert = require('node:assert/strict');

const { postingPrices } = require('../src/routes/advertising');

// The price shown on the Posting Plan must be the price the ad ACTUALLY quotes,
// not the unit's raw rent range. The advertised rate steps DOWN as availability
// nears (computePostingRent), so a badge built from rent_price_min alone would
// tell the operator a number the post does not contain.
const unit = (over = {}) => ({
  unit_id: 101n, unit_name: '5B',
  rent_price_min: 20000, rent_price_max: 30000, days_left: 90,
  ...over,
});

test('uses the rendered %PostingRentAmount% — the exact figure in the ad text', () => {
  const bundle = { units: [unit()] };
  // The renderer resolved a different number than the step-down would give (this
  // happens when the unit has no advertised range and falls back to the last
  // lease). The ad wins; anything else puts a lie on the operator's screen.
  const rendered = { unit_values: [{ '%PostingRentAmount%': '18,500' }] };

  assert.equal(postingPrices(bundle, rendered)[0].posting_rent, 18500);
});

test('falls back to the step-down price when there is no template to render', () => {
  // needs_template / no_slot rows never call renderBundle, but the operator still
  // needs to see what the unit would be advertised at.
  const bundle = { units: [unit({ days_left: 90 })] };

  const [p] = postingPrices(bundle, null);

  assert.equal(p.posting_rent, 30000);   // >= 8 weeks out → top of range
  assert.equal(p.posting_tier, 'high');
});

test('surfaces the discount tier for a unit that has sat vacant', () => {
  // -30 = vacant for 30 days → low minus 10%. The tier is the whole point of
  // showing this: it is how the operator notices they are discounting.
  const bundle = { units: [unit({ days_left: -30 })] };

  const [p] = postingPrices(bundle, null);

  assert.equal(p.posting_rent, 18000);
  assert.equal(p.posting_tier, 'discount');
});

test('a unit with no advertised range reports null rather than a fake zero', () => {
  // Number(null) is 0, which would render as a real HK$0 asking rent.
  const bundle = { units: [unit({ rent_price_min: null, rent_price_max: null })] };

  const [p] = postingPrices(bundle, null);

  assert.equal(p.posting_rent, null);
  assert.equal(p.posting_tier, null);
});

test('prices stay aligned with units when the middle unit fails to resolve', () => {
  // renderBundle pushes null for a unit that vanished mid-build. If alignment
  // were by filtered index instead, unit C would be shown unit B's price.
  const bundle = { units: [
    unit({ unit_id: 1, unit_name: 'A' }),
    unit({ unit_id: 2, unit_name: 'B' }),
    unit({ unit_id: 3, unit_name: 'C' }),
  ] };
  const rendered = { unit_values: [
    { '%PostingRentAmount%': '11,000' },
    null,
    { '%PostingRentAmount%': '33,000' },
  ] };

  const out = postingPrices(bundle, rendered);

  assert.deepEqual(out.map(p => p.unit_name), ['A', 'B', 'C']);
  assert.equal(out[0].posting_rent, 11000);
  assert.equal(out[1].posting_rent, 30000);  // no rendered value → step-down
  assert.equal(out[2].posting_rent, 33000);
});

test('ignores a rendered value that is blank or non-numeric', () => {
  const bundle = { units: [unit()] };
  const rendered = { unit_values: [{ '%PostingRentAmount%': '' }] };

  assert.equal(postingPrices(bundle, rendered)[0].posting_rent, 30000);
});

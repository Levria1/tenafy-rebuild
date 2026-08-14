const test = require('node:test');
const assert = require('node:assert/strict');

const ORG_ID = 'org-1';

const UNIT_ROWS = [
  unitRow({ id: 'gilmans-5a', name: '5A', property_id: 'gilmans', property_name: "Gilman's Bazaar", district: 'Central', street_address: "36 Gilman's Bazaar", listing_url: 'https://taneresidence.com/product/gilmans-5a/' }),
  unitRow({ id: 'hollywood-5a', name: '5A', property_id: 'hollywood', property_name: 'Hollywood', district: 'Sheung Wan', street_address: '84 Hollywood Road, Sheung Wan', listing_url: 'https://taneresidence.com/product/hollywood-5a/' }),
  unitRow({ id: 'mercer-5a', name: '5A', property_id: 'mercer', property_name: 'Mercer', district: 'Sheung Wan', street_address: '10 Mercer Street, Sheung Wan', listing_url: 'https://taneresidence.com/product/mercer-5a/' }),
  unitRow({ id: 'mong-kok-5a', name: '5A', property_id: 'mong-kok', property_name: 'Mong Kok', district: 'Mong Kok', street_address: '95 Tung Choi Street, Mong Kok', listing_url: 'https://taneresidence.com/product/mong-kok-5a/' }),
  unitRow({ id: 'poplar-5a', name: '5A', property_id: 'poplar', property_name: 'Poplar', district: 'Prince Edward', street_address: '23 Poplar Street', listing_url: 'https://taneresidence.com/product/poplar-5a/' }),
];

function unitRow(overrides) {
  return {
    city: 'Hong Kong',
    cur_ve: 1,
    has_lease: 1,
    host_links: 0,
    ...overrides,
  };
}

function listingRows() {
  return UNIT_ROWS.map(row => ({ unit_id: row.id, listing_url: row.listing_url }));
}

function makePool() {
  return {
    execute: async (sql, params) => {
      assert.deepEqual(params, [ORG_ID]);
      if (/SELECT u\.id AS unit_id, u\.listing_url/.test(sql)) return [listingRows()];
      if (/SELECT u\.id, u\.name, u\.property_id/.test(sql)) return [UNIT_ROWS];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function resolveHandler() {
  delete require.cache[require.resolve('../src/routes/public')];
  const publicRouter = require('../src/routes/public');
  return publicRouter.stack
    .find(layer => layer.route?.path === '/units/resolve' && layer.route.methods.post)
    .route.stack.at(-1).handle;
}

async function callResolve(body, pool = makePool()) {
  const handler = resolveHandler();
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await handler({ body, pool, apiKey: { orgId: ORG_ID } }, res);
  return res;
}

test('POST /units/resolve regression: Mong Kok Flat 5A resolves to Mong Kok, not Poplar', async () => {
  const res = await callResolve({ unit_text: 'Mong Kok Flat 5A' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.status, 'confident');
  assert.equal(res.body.data.resolved_by, 'unit_text');
  assert.equal(res.body.data.match.unit_id, 'mong-kok-5a');
  assert.equal(res.body.data.match.label, 'Mong Kok 5A');
  assert.equal(res.body.data.query, 'mong kok flat 5a');
});

test('POST /units/resolve returns ambiguous candidates for bare 5A', async () => {
  const res = await callResolve({ unit_text: '5A' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'ambiguous');
  assert.equal(res.body.data.match, null);
  assert.equal(res.body.data.candidates.length, 5);
});

test('POST /units/resolve returns none for unmatched unit_text', async () => {
  const res = await callResolve({ unit_text: 'not a real flat' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'none');
  assert.equal(res.body.data.match, null);
  assert.deepEqual(res.body.data.candidates, []);
});

test('POST /units/resolve resolves a real unit_id confidently', async () => {
  const res = await callResolve({ unit_id: 'mong-kok-5a' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'confident');
  assert.equal(res.body.data.resolved_by, 'unit_id');
  assert.equal(res.body.data.match.unit_id, 'mong-kok-5a');
  assert.equal(res.body.data.match.marketable, true);
});

test('POST /units/resolve returns none for another org unit_id without leaking existence', async () => {
  const res = await callResolve({ unit_id: 'other-org-unit' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'none');
  assert.equal(res.body.data.resolved_by, 'unit_id');
  assert.equal(res.body.data.match, null);
});

test('POST /units/resolve resolves exact listing_url confidently', async () => {
  const res = await callResolve({ listing_url: 'https://taneresidence.com/product/mong-kok-5a/' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'confident');
  assert.equal(res.body.data.resolved_by, 'listing_url');
  assert.equal(res.body.data.match.unit_id, 'mong-kok-5a');
});

test('POST /units/resolve keeps listing_url normalisation for fbclid and trailing slash', async () => {
  const res = await callResolve({ listing_url: 'https://taneresidence.com/product/mong-kok-5a/?fbclid=abc123' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'confident');
  assert.equal(res.body.data.resolved_by, 'listing_url');
  assert.equal(res.body.data.match.unit_id, 'mong-kok-5a');
});

test('POST /units/resolve falls through from unknown listing_url to unit_text', async () => {
  const res = await callResolve({
    listing_url: 'https://taneresidence.com/product/stale-ad/',
    unit_text: 'Mong Kok Flat 5A',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'confident');
  assert.equal(res.body.data.resolved_by, 'unit_text');
  assert.equal(res.body.data.match.unit_id, 'mong-kok-5a');
});

test('POST /units/resolve returns none for unknown listing_url without unit_text', async () => {
  const res = await callResolve({ listing_url: 'https://taneresidence.com/product/stale-ad/' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'none');
  assert.equal(res.body.data.resolved_by, 'listing_url');
  assert.equal(res.body.data.match, null);
});

test('POST /units/resolve rejects requests without unit_id, listing_url, or unit_text', async () => {
  const res = await callResolve({});

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'unit_id, listing_url, or unit_text is required');
});

test('POST /units/resolve rejects unit_text longer than 500 chars', async () => {
  const res = await callResolve({ unit_text: 'x'.repeat(501) });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'unit_text must be 500 characters or fewer');
});

test('POST /units/resolve gives unit_id precedence over unit_text', async () => {
  const res = await callResolve({ unit_id: 'poplar-5a', unit_text: 'Mong Kok Flat 5A' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'confident');
  assert.equal(res.body.data.resolved_by, 'unit_id');
  assert.equal(res.body.data.match.unit_id, 'poplar-5a');
});

test('POST /units/resolve emits the same unit shape as the viewing resolver', async () => {
  // The two endpoints promise partners ONE unit vocabulary. This fails the moment
  // either grows a field the other lacks, which is the drift a hand-copied
  // formatter would have hidden.
  const { unitOut, scoreUnits } = require('../src/services/unitResolver');
  // Same mapping loadUnitsWithMarketable applies to these rows.
  const mapped = UNIT_ROWS.map(r => ({
    id: r.id, name: r.name, property_id: r.property_id, property_name: r.property_name,
    district: r.district, city: r.city, street_address: r.street_address,
    marketable: (Number(r.has_lease) > 0 && Number(r.cur_ve) === 1) || (Number(r.has_lease) === 0 && Number(r.host_links) > 0),
  }));

  const res = await callResolve({ unit_text: 'Mong Kok Flat 5A' });
  const viaResolver = scoreUnits('Mong Kok Flat 5A', mapped).match;

  assert.deepEqual(Object.keys(res.body.data.match).sort(), Object.keys(viaResolver).sort());
  assert.deepEqual(res.body.data.match, viaResolver);
  assert.deepEqual(res.body.data.match, unitOut(mapped.find(u => String(u.id) === res.body.data.match.unit_id)));
});

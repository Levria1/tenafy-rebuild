const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// NPH 7D: a draft lease deleted in September still blocked Airbnb until March,
// because the feed query never looked at deleted_at. Airbnb imports the block,
// so staff could not unblock those dates on Airbnb either.

const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const LEASES = [
  { lease_id: 'LIVE', start_date: ymd(-10), end_date: ymd(30), deleted: false },
  { lease_id: 'DELETED', start_date: ymd(-10), end_date: ymd(150), deleted: true },
];

function loadRouter(pool) {
  const stub = (rel, exports) => {
    const id = require.resolve(rel);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('../src/middleware/viewingTokenAuth', {
    KIND_ICAL: 'ical',
    resolveOrgByIcalToken: (req, res, next) => { req.pool = pool; next(); },
  });
  stub('../src/config/poolRegistry', { getMasterPool: () => ({}) });
  delete require.cache[require.resolve('../src/routes/ical')];
  return require('../src/routes/ical');
}

// Answers the two feed queries the way MySQL would, honouring a deleted_at filter
// only if the SQL actually has one.
const pool = {
  async execute(sql) {
    if (/FROM unit u WHERE u.ical_token/.test(sql)) return [[{ id: 'u7d', name: '7D' }]];
    if (/FROM leasing l/.test(sql)) {
      const skipDeleted = /l\.deleted_at IS NULL/.test(sql);
      return [LEASES.filter(l => !(skipDeleted && l.deleted))];
    }
    return [[]];
  },
};

test('a deleted lease does not block the unit in the Airbnb feed', async () => {
  const app = express();
  app.use('/api/ical', loadRouter(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ical/unit/ical_test.ics`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /UID:lease-LIVE@tenafy/);
    assert.doesNotMatch(body, /UID:lease-DELETED@tenafy/);
  } finally { server.close(); }
});

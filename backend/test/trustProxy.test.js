const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

// Behind nginx every request arrived from 127.0.0.1, so the portal login limit
// treated every tenant as the same visitor. The fix trusts the local proxy only.

test('index.js trusts the loopback proxy, never every proxy', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(src, /app\.set\('trust proxy', 'loopback'\)/);
  assert.doesNotMatch(src, /app\.set\('trust proxy', true\)/);
});

function appWithLimit() {
  const app = express();
  app.set('trust proxy', 'loopback');
  const limiter = rateLimit({ windowMs: 60000, limit: 2, standardHeaders: true, legacyHeaders: false });
  app.get('/login', limiter, (req, res) => res.json({ ip: req.ip }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('two visitors behind nginx get separate rate limits', async () => {
  await withServer(appWithLimit(), async (base) => {
    const as = (ip) => fetch(`${base}/login`, { headers: { 'X-Forwarded-For': ip } });
    assert.equal((await as('203.0.113.5')).status, 200);
    assert.equal((await as('203.0.113.5')).status, 200);
    assert.equal((await as('203.0.113.5')).status, 429, 'the noisy visitor is limited');
    const other = await as('198.51.100.7');
    assert.equal(other.status, 200, 'a different tenant is not locked out');
    assert.equal((await other.json()).ip, '198.51.100.7');
  });
});

test('a forged X-Forwarded-For cannot dodge the limit', async () => {
  // nginx APPENDS the real address, so a client-supplied value ends up on the
  // left; only the right-most (added by our own proxy) is believed.
  await withServer(appWithLimit(), async (base) => {
    const forged = (fake) => fetch(`${base}/login`, { headers: { 'X-Forwarded-For': `${fake}, 203.0.113.9` } });
    assert.equal((await forged('1.1.1.1')).status, 200);
    assert.equal((await forged('2.2.2.2')).status, 200);
    const third = await forged('3.3.3.3');
    assert.equal(third.status, 429, 'changing the forged part does not reset the count');
  });
});

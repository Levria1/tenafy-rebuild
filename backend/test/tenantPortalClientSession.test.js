/**
 * Guards the three ways the tenant portal's browser code can lose the session.
 *
 * These are source assertions, not behaviour tests: the portal frontend has no test
 * harness, and every one of these regressions is a single line that reads perfectly
 * fine in review. They are worth pinning because all three were shipped at once and
 * left the portal impossible to sign into, silently.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const LOGIN = '../../frontend/src/app/tenant-portal/login/page.js';
const LAYOUT = '../../frontend/src/app/tenant-portal/layout.js';
const CLIENT = '../../frontend/src/lib/tenantApi.js';

// Comments in these files quote the old broken lines on purpose, so every check below
// strips comments first. Without this the tests pass or fail on prose.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PORTAL_FILES = [LOGIN, LAYOUT, CLIENT];

// ── the staff cookie must not appear in tenant code ─────────────────────────

test('no tenant portal file references the staff cookie __s_t', () => {
  // The login page used to write the session into __s_t, the cookie name staff auth
  // reads. Beyond not working, it puts a tenant value where staff middleware looks.
  for (const rel of PORTAL_FILES) {
    const code = stripComments(read(rel));
    assert.ok(!code.includes('__s_t'), `${rel} still references the staff cookie __s_t`);
  }
});

test('no tenant portal file imports js-cookie', () => {
  // The session cookie is httpOnly. Any js-cookie call against it is dead code that
  // reads as a working check, which is exactly how the layout gate failed.
  for (const rel of PORTAL_FILES) {
    const code = stripComments(read(rel));
    assert.ok(!/from ['"]js-cookie['"]/.test(code), `${rel} still imports js-cookie`);
    assert.ok(!/\bCookies\.(get|set|remove)\s*\(/.test(code), `${rel} still calls js-cookie`);
  }
});

// ── login ───────────────────────────────────────────────────────────────────

test('login does not read a token out of the response body', () => {
  // POST /login returns { code, message } and nothing else; the token is set as a
  // cookie server-side. Reading data.token threw on every successful login.
  const code = stripComments(read(LOGIN));
  assert.ok(!/data\s*\.\s*token/.test(code), 'login page still reads a token from the response');
});

test('login sends the tenant to the dashboard on success', () => {
  const code = stripComments(read(LOGIN));
  assert.match(code, /router\.replace\(['"]\/tenant-portal\/dashboard['"]\)/);
});

// ── the session gate ────────────────────────────────────────────────────────

test('the layout establishes the session by asking the server', () => {
  // The gate has to be a request. Nothing in the browser can see an httpOnly cookie,
  // so any purely client-side check is either always true or always false.
  const code = stripComments(read(LAYOUT));
  assert.match(code, /await\s+tenantPortal\.getProfile\(\)/);
});

test('the layout does not probe the pages that must work signed out', () => {
  const code = stripComments(read(LAYOUT));
  assert.match(code, /isAuthPage/);
  for (const p of ['/tenant-portal/login', '/tenant-portal/register', '/tenant-portal/set-password']) {
    assert.ok(code.includes(p), `layout does not exempt ${p} from the session probe`);
  }
});

test('the layout treats 401 and 403 as the redirect the client already performs', () => {
  // Rendering an error under an in-flight redirect flashes a fault screen at someone
  // who is simply signed out.
  const code = stripComments(read(LAYOUT));
  assert.match(code, /status\s*!==\s*401\s*&&\s*status\s*!==\s*403/);
});

// ── logout ──────────────────────────────────────────────────────────────────

test('logout calls the server instead of deleting a cookie locally', () => {
  // Deleting a cookie in JS cannot clear an httpOnly one. The old logout navigated to
  // the login page with the session still live, so Back put you straight back in.
  const code = stripComments(read(LAYOUT));
  assert.match(code, /await\s+tenantPortal\.logout\(\)/);
  assert.match(code, /router\.replace\(['"]\/tenant-portal\/login['"]\)/);
});

// ── the client itself ───────────────────────────────────────────────────────

test('the tenant api client sends cookies and sets no auth header', () => {
  const code = stripComments(read(CLIENT));
  assert.match(code, /withCredentials:\s*true/);
  assert.ok(!/Authorization/i.test(code), 'tenant client is setting an Authorization header again');
});

test('the login redirect list in the client matches the layout exemptions', () => {
  // These two lists decide the same thing from opposite ends. If they drift, a page
  // is either unreachable signed out or gated by a probe that cannot succeed.
  const client = stripComments(read(CLIENT));
  const layout = stripComments(read(LAYOUT));
  for (const p of ['/tenant-portal/login', '/tenant-portal/register', '/tenant-portal/set-password']) {
    assert.ok(client.includes(p), `client redirect guard is missing ${p}`);
    assert.ok(layout.includes(p), `layout probe exemption is missing ${p}`);
  }
});

// ── the server side of the same contract ────────────────────────────────────
//
// The frontend fix above is only correct because the session arrives as a cookie and
// never in the body. Nothing asserted that, which is how the two sides drifted apart
// in the first place: the login route was rewritten and its caller was not.

test('issueTenantSession sets an httpOnly tenant cookie and puts nothing in the body', () => {
  process.env.JWT_SECRET = 'staff-secret-that-is-long-enough-to-be-real-000';
  process.env.TENANT_JWT_SECRET = 'tenant-secret-that-is-long-enough-to-be-real-1';
  // Required before the middleware loads: it resolves the secret once, at require time.
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/middleware/tenantAuth')];
  const { issueTenantSession, TENANT_COOKIE } = require('../src/middleware/tenantAuth');

  const cookies = [];
  const body = [];
  const res = {
    cookie: (name, value, options) => cookies.push({ name, value, options }),
    json: (payload) => body.push(payload),
  };

  issueTenantSession(res, { email: 'a@b.com', orgId: '8300127259922432', tokenVersion: 0 });

  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, TENANT_COOKIE);
  assert.equal(TENANT_COOKIE, '__t_p', 'the tenant cookie must not be the staff cookie name');
  assert.equal(cookies[0].options.httpOnly, true, 'the session cookie must be httpOnly');
  assert.equal(cookies[0].options.sameSite, 'lax');
  assert.ok(cookies[0].value.length > 20);
  assert.equal(body.length, 0, 'issuing a session must not write a response body');
});

test('the login route returns no token for the browser to store', () => {
  // If a token ever reappears here, the login page will start storing it again and the
  // httpOnly guarantee is gone.
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/tenantPortal.js'), 'utf8');
  const start = src.indexOf("router.post('/login'");
  const end = src.indexOf("router.post('/logout'");
  assert.ok(start > -1 && end > start, 'could not isolate the login handler');
  const handler = stripComments(src.slice(start, end));
  assert.ok(!/token:/.test(handler), 'the login response body contains a token again');
  assert.match(handler, /issueTenantSession\(res,/);
});

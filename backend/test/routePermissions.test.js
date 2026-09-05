/**
 * Customer data must be gated on the server, not only in the menu.
 *
 * The app decided what a user could reach by choosing which menu items to
 * render. That is a decision made in the browser: the server asked only whether
 * someone was logged in. Anyone with a link — bookmarked, forwarded, or simply
 * remembered — could open a tenant, a lease or a document regardless of role.
 *
 * Nothing was actually leaking, because every role in the live org already held
 * TENANT_LIST. It would have started leaking the first time a genuinely
 * restricted role existed: a cleaner, a contractor, a junior on trial. The
 * Documents tab now carries passport and HKID scans, which raised the stakes.
 *
 * These tests pin the gate onto the routes. They are source inspection because
 * mounting the real router needs Express, MySQL and a live session, and the
 * realistic regression is a new route added without a permission rather than
 * someone deleting the middleware wholesale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');

// Route declarations of the form router.<method>('<path>', ...
const ROUTE_RE = /router\.(get|post|put|delete)\('([^']+)'\s*,([^\n]*)/g;

function routesOf(file) {
  const src = read(file);
  const out = [];
  let m;
  while ((m = ROUTE_RE.exec(src)) !== null) {
    out.push({ method: m[1], route: m[2], rest: m[3] });
  }
  return out;
}

// Endpoints that are deliberately reachable without a permission code.
const EXEMPT = {
  'file.js': ['/preview/:identifier', '/download/:identifier'],
};

for (const file of ['tenant.js', 'leasing.js']) {
  test(`every route in ${file} carries a permission check`, () => {
    const ungated = routesOf(file)
      .filter((r) => !/requirePermission\(/.test(r.rest))
      .map((r) => `${r.method.toUpperCase()} ${r.route}`);
    assert.deepEqual(ungated, [],
      `these routes serve customer data behind a login alone: ${ungated.join(', ')}`);
  });
}

test('reads and writes are gated on different codes', () => {
  const src = read('tenant.js');
  // A read gated on EDIT would lock out legitimate viewers; a write gated on
  // DETAIL would let a read-only role change data. Both are easy to get wrong
  // in a bulk change like this one, so pin a sample of each.
  const expectations = [
    ["router.get('/:id', authenticate, requirePermission('LANDLORD/TENANT_DETAIL')", 'reading a tenant'],
    ["router.put('/:id/profile', authenticate, requirePermission('LANDLORD/TENANT_EDIT')", 'editing a tenant'],
    ["router.post('/', authenticate, requirePermission('LANDLORD/TENANT_CREATE')", 'creating a tenant'],
    ["router.delete('/:id', authenticate, requirePermission('LANDLORD/TENANT_DELETE')", 'deleting a tenant'],
    ["router.get('/:id/files', authenticate, requirePermission('LANDLORD/TENANT_DETAIL')", 'listing ID documents'],
    ["router.delete('/:id/files/:fileId', authenticate, requirePermission('LANDLORD/TENANT_EDIT')", 'removing a document'],
  ];
  for (const [needle, what] of expectations) {
    assert.ok(src.includes(needle), `${what} is not gated as expected`);
  }
});

test('Smart Extract needs a write permission, not merely a login', () => {
  // It reads an ID document AND writes a file row, so a view-only role has no
  // business calling it. Either write code is enough: it serves both forms.
  const src = read('tenant.js');
  assert.match(src, /router\.post\('\/parse', authenticate, requirePermission\('LANDLORD\/TENANT_CREATE', 'LANDLORD\/TENANT_EDIT'\)/);
});

test('creating a login for a contact is gated on USER_CREATE', () => {
  // The most consequential thing in contact.js: it hands somebody an account.
  // It must not ride on the contact permissions of whoever is looking at them.
  const src = read('contact.js');
  for (const route of ['/tenant/create/user', '/property-owner/create/user',
                       '/tenant/check/user', '/property-owner/check/user']) {
    assert.ok(src.includes(`router.post('${route}', authenticate, requirePermission('LANDLORD/USER_CREATE')`),
      `${route} must require USER_CREATE`);
  }
});

test('the public file routes stay public, and stay ahead of the auth middleware', () => {
  // These exist so listing photos load for anonymous visitors. Gating them
  // would take the public site down; ID documents are held back by is_private
  // instead. See filePrivacy.test.js.
  const src = read('file.js');
  for (const route of EXEMPT['file.js']) {
    assert.ok(src.includes(`router.get('${route}', async`),
      `${route} should take no middleware at all`);
  }
});

test('no route grants itself a permission that does not exist elsewhere', () => {
  // A typo in a permission code fails closed and silently: nobody holds
  // 'LANDLROD/TENANT_LIST', so the route 403s for everyone including admins.
  // Every code used must appear somewhere the frontend or seed data also knows.
  const used = new Set();
  for (const file of ['tenant.js', 'leasing.js', 'contact.js']) {
    for (const m of read(file).matchAll(/requirePermission\(([^)]*)\)/g)) {
      for (const c of m[1].matchAll(/'([^']+)'/g)) used.add(c[1]);
    }
  }
  // 16 distinct codes across the three files at the time of writing. The bound
  // is a smoke test that the regex still matches something, not a target.
  assert.ok(used.size >= 12, `expected the gates to use many codes, found ${used.size}`);
  for (const code of used) {
    assert.match(code, /^LANDLORD\/[A-Z_/]+$/, `${code} is not a well-formed permission code`);
  }
});

/**
 * Login must find the user inside the org the routing table resolved.
 *
 * This database carries user rows for eleven organisations that no longer exist, left
 * over from the original multi-tenant system. One address matches two of them: the owner
 * has a row on Tane and a row on a defunct org, both active.
 *
 * The lookup was `WHERE username = ? OR email = ? LIMIT 1` with no org filter and no
 * ordering, so which row logged you in was whichever MySQL returned. That is not
 * academic: the session's org comes from the ROW (`orgId: user.org_id`), not from the
 * routing table, so picking the phantom row issues a token for an org that cannot be
 * opened and every following request fails. The password would also be compared against
 * the wrong row's hash.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AUTH = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');

const lookup = (marker, end) => {
  const at = AUTH.indexOf(marker);
  assert.ok(at > -1, `${marker} is gone`);
  return AUTH.slice(at, AUTH.indexOf(end, at));
};

test('login scopes the user lookup to the resolved org', () => {
  const code = lookup('// 2. Look up user in org database', 'if (users.length === 0)');
  assert.match(code, /AND org_id = \?/);
  assert.match(code, /orgInfo\.orgId/);
});

test('login breaks the tie deterministically, preferring an active row', () => {
  const code = lookup('// 2. Look up user in org database', 'if (users.length === 0)');
  assert.match(code, /ORDER BY status DESC, id DESC/);
});

test('the password reset lookup is scoped the same way', () => {
  // Otherwise the code is emailed for one row and the password set on the other.
  const code = lookup("router.post('/forget-password/initialize'", 'if (users.length === 0)');
  assert.match(code, /AND org_id = \?/);
  assert.match(code, /orgInfo\.orgId/);
});

test('no user lookup in auth.js matches on name alone', () => {
  // Any `WHERE username = ? OR email = ?` without an org filter reintroduces the
  // ambiguity in a new place.
  const bare = [...AUTH.matchAll(/WHERE\s+\(?(?:username|email)\s*=\s*\?\s*OR\s*(?:username|email)\s*=\s*\?\)?([^`']*)/g)];
  assert.ok(bare.length > 0, 'expected to find the lookups');
  for (const m of bare) {
    assert.match(m[1], /AND org_id = \?/, 'a user lookup matches on name without scoping to an org');
  }
});

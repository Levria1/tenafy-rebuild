const test = require('node:test');
const assert = require('node:assert/strict');

const { READ_ONLY_SAFE_POSTS, isReadOnlySafePost } = require('../src/middleware/apiKeyAuth');

// A read-only key is the ONLY kind a lookup integration should hold. If
// /units/resolve is not reachable with one, the partner is pushed onto a
// read-write key to do a read — which is how a lookup integration ends up
// holding a key that can create leases.
test('a read-only key may POST to /units/resolve', () => {
  assert.equal(isReadOnlySafePost({ method: 'POST', path: '/units/resolve' }), true);
});

test('a trailing slash cannot slip past the allowlist check', () => {
  assert.equal(isReadOnlySafePost({ method: 'POST', path: '/units/resolve/' }), true);
});

test('the allowlist does not open any other POST', () => {
  for (const path of [
    '/viewing-negotiation/start',
    '/viewing-negotiation/reply',
    '/viewing-negotiation/:id/cancel',
    '/viewing-negotiation/1/cancel',
    '/inquiries',
    '/units',
  ]) {
    assert.equal(isReadOnlySafePost({ method: 'POST', path }), false, `${path} must stay closed`);
  }
});

test('the allowlist never opens a real write method on the same path', () => {
  // Same path, mutating verbs. Only POST was ever asserted to be side-effect free.
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal(isReadOnlySafePost({ method, path: '/units/resolve' }), false, `${method} must stay closed`);
  }
});

test('a path prefix does not inherit the allowance', () => {
  // Guards against a future '/units/resolve/bulk' being reachable for free.
  assert.equal(isReadOnlySafePost({ method: 'POST', path: '/units/resolve/bulk' }), false);
});

test('the allowlist stays small and deliberate', () => {
  // Not style policing: every entry is reachable by every read-only key, so
  // growth here is a security change and should fail a test until reviewed.
  assert.deepEqual([...READ_ONLY_SAFE_POSTS], ['/units/resolve']);
});

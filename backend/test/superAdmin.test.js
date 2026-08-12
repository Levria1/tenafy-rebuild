const test = require('node:test');
const assert = require('node:assert/strict');
const { isSuperAdmin } = require('../src/middleware/auth');

test('isSuperAdmin preserves orgType 6 super admin behaviour', () => {
  assert.equal(isSuperAdmin({ user: { orgType: 6 } }), true);
});

test('isSuperAdmin allows the per-user super admin grant', () => {
  assert.equal(isSuperAdmin({ user: { orgType: 0, isSuperAdmin: true } }), true);
});

test('isSuperAdmin rejects false per-user grant outside orgType 6', () => {
  assert.equal(isSuperAdmin({ user: { orgType: 0, isSuperAdmin: false } }), false);
});

test('isSuperAdmin rejects pre-migration tokens without isSuperAdmin outside orgType 6', () => {
  assert.equal(isSuperAdmin({ user: { orgType: 0 } }), false);
});

test('isSuperAdmin accepts string orgType 6', () => {
  assert.equal(isSuperAdmin({ user: { orgType: '6' } }), true);
});

test('isSuperAdmin handles missing req.user', () => {
  assert.equal(isSuperAdmin({}), false);
});

test('isSuperAdmin accepts numeric TINYINT values from MySQL', () => {
  // MySQL TINYINT reaches us as 0/1, not a JS boolean, so the per-user check
  // must use truthiness instead of `=== true`.
  assert.equal(isSuperAdmin({ user: { orgType: 0, isSuperAdmin: 1 } }), true);
});

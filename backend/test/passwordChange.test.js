const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const {
  getPasswordChangedAt,
  invalidatePasswordChangedAt,
  isTokenRevoked,
  _resetCacheForTests,
} = require('../src/utils/sessionRevocation');
const { changeOwnPassword, markPasswordChanged } = require('../src/services/passwordChange');

test.beforeEach(() => _resetCacheForTests());

test('isTokenRevoked returns false when password_changed_at is null', async () => {
  const pool = { execute: async () => [[{ changed: null }]] };
  assert.equal(await isTokenRevoked(pool, { id: '9', orgId: '3', iat: 100 }), false);
});

test('isTokenRevoked rejects only tokens issued before the password change', async () => {
  const pool = { execute: async () => [[{ changed: 101 }]] };
  assert.equal(await isTokenRevoked(pool, { id: '9', orgId: '3', iat: 100 }), true);
  _resetCacheForTests();
  assert.equal(await isTokenRevoked(pool, { id: '9', orgId: '3', iat: 101 }), false);
});

test('isTokenRevoked fails open when the migration is missing', async () => {
  const pool = { execute: async () => { throw new Error('Unknown column password_changed_at'); } };
  assert.equal(await isTokenRevoked(pool, { id: '9', orgId: '3', iat: 100 }), false);
});

test('isTokenRevoked fails open on generic database errors', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const pool = { execute: async () => { throw new Error('connection lost'); } };
    assert.equal(await isTokenRevoked(pool, { id: '9', orgId: '3', iat: 100 }), false);
  } finally {
    console.error = originalError;
  }
});

test('password change timestamp is cached until invalidated', async () => {
  let changed = 100;
  let calls = 0;
  const pool = { execute: async () => { calls += 1; return [[{ changed }]]; } };
  assert.equal(await getPasswordChangedAt(pool, '3', '9'), 100);
  changed = 200;
  assert.equal(await getPasswordChangedAt(pool, '3', '9'), 100);
  assert.equal(calls, 1);
  invalidatePasswordChangedAt('3', '9');
  assert.equal(await getPasswordChangedAt(pool, '3', '9'), 200);
  assert.equal(calls, 2);
});

test('changeOwnPassword rejects a short password', async () => {
  const result = await changeOwnPassword({}, { userId: '9', orgId: '3' }, {
    currentPassword: 'old password', newPassword: 'too-short',
  });
  assert.deepEqual(result, {
    ok: false, status: 400, code: 4005,
    message: 'New password must be at least 12 characters',
  });
});

test('changeOwnPassword rejects reusing the current password', async () => {
  const password = 'same-password';
  const result = await changeOwnPassword({}, { userId: '9', orgId: '3' }, {
    currentPassword: password, newPassword: password,
  });
  assert.equal(result.code, 4006);
});

test('changeOwnPassword rejects the wrong current password', async () => {
  const hash = `{bcrypt}${await bcrypt.hash('correct password', 4)}`;
  const pool = { execute: async () => [[{ id: '9', password: hash }]] };
  const result = await changeOwnPassword(pool, { userId: '9', orgId: '3' }, {
    currentPassword: 'wrong password', newPassword: 'a-new-password',
  });
  assert.equal(result.code, 4004);
});

test('changeOwnPassword updates timestamp and scopes reads and writes by user and org', async () => {
  const hash = `{bcrypt}${await bcrypt.hash('correct password', 4)}`;
  const calls = [];
  const pool = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT/.test(sql)) return [[{ id: '90071992547409931', password: hash }]];
      return [{ affectedRows: 1 }];
    },
  };
  const result = await changeOwnPassword(pool, {
    userId: '90071992547409931', orgId: '90071992547409932',
  }, { currentPassword: 'correct password', newPassword: 'a-new-password' });

  assert.equal(result.ok, true);
  assert.equal(typeof result.changedAt, 'number');
  assert.match(calls[0].sql, /WHERE id = \? AND org_id = \?/);
  assert.deepEqual(calls[0].params, ['90071992547409931', '90071992547409932']);
  assert.match(calls[1].sql, /password_changed_at = FROM_UNIXTIME\(\?\)/);
  assert.match(calls[1].sql, /WHERE id = \? AND org_id = \?/);
  assert.deepEqual(calls[1].params.slice(-2), ['90071992547409931', '90071992547409932']);
  assert.match(calls[1].params[0], /^\{bcrypt\}\$2[aby]\$/);
});

test('changeOwnPassword retries without timestamp when the column is missing', async () => {
  const hash = `{bcrypt}${await bcrypt.hash('correct password', 4)}`;
  const calls = [];
  const pool = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT/.test(sql)) return [[{ id: '9', password: hash }]];
      if (/password_changed_at/.test(sql)) throw new Error('Unknown column password_changed_at');
      return [{ affectedRows: 1 }];
    },
  };
  const result = await changeOwnPassword(pool, { userId: '9', orgId: '3' }, {
    currentPassword: 'correct password', newPassword: 'a-new-password',
  });
  assert.deepEqual(result, { ok: true, changedAt: null });
  assert.match(calls[2].sql, /updated_at = NOW\(\) WHERE id = \? AND org_id = \?/);
  assert.deepEqual(calls[2].params.slice(-2), ['9', '3']);
});

test('markPasswordChanged scopes the timestamp update by user and org', async () => {
  let call;
  const pool = { execute: async (sql, params) => { call = { sql, params }; return [{}]; } };
  await markPasswordChanged(pool, '90071992547409932', '90071992547409931');
  assert.match(call.sql, /WHERE id = \? AND org_id = \?/);
  assert.deepEqual(call.params.slice(-2), ['90071992547409931', '90071992547409932']);
});

test('changing the password ends other sessions straight away, not after the cache expires', async () => {
  // Before the change: no timestamp, and that null is now cached for this user.
  const hash = await bcrypt.hash('old-password-123', 4);
  let changed = null;
  const pool = {
    execute: async (sql, params) => {
      if (/^SELECT UNIX_TIMESTAMP/.test(sql)) return [[{ changed }]];
      if (/^SELECT id, password/.test(sql)) return [[{ id: '9', password: `{bcrypt}${hash}` }]];
      if (/^UPDATE user SET password = \?, password_changed_at/.test(sql)) { changed = params[1]; return [{}]; }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const oldToken = { id: '9', orgId: '3', iat: Math.floor(Date.now() / 1000) - 60 };
  assert.equal(await isTokenRevoked(pool, oldToken), false);

  const result = await changeOwnPassword(pool, { userId: '9', orgId: '3' },
    { currentPassword: 'old-password-123', newPassword: 'brand-new-password-456' });
  assert.equal(result.ok, true);

  // A stale cached null would let the old token through for up to 30 seconds.
  assert.equal(await isTokenRevoked(pool, oldToken), true);
});

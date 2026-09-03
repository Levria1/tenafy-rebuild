const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const {
  TENANT_COOKIE,
  resolveTenantSecret,
  signTenantToken,
  verifyTenantToken,
} = require('../src/utils/tenantPortalTokens');

const STAFF_SECRET = 'staff-secret-that-is-long-enough-to-be-real-000';
const TENANT_SECRET = 'tenant-secret-that-is-long-enough-to-be-real-1';

// ── the boundary itself ─────────────────────────────────────────────────────

test('a tenant token does NOT verify against the staff secret', () => {
  // The whole point. 412 staff endpoints call jwt.verify(token, config.jwtSecret);
  // this must throw for anything the tenant portal issued.
  const token = signTenantToken({ email: 'a@b.com', orgId: '830' }, TENANT_SECRET);
  assert.throws(() => jwt.verify(token, STAFF_SECRET), /invalid signature/i);
});

test('a staff token does NOT verify as a tenant token', () => {
  const staffToken = jwt.sign({ userId: '1', orgId: '830', role: 'admin' }, STAFF_SECRET);
  const { payload, error } = verifyTenantToken(staffToken, TENANT_SECRET);
  assert.equal(payload, undefined);
  assert.match(error, /invalid or expired/i);
});

test('a token with the right secret but the wrong role is refused', () => {
  // Belt and braces: if a future bug signs a staff-shaped payload with the tenant
  // secret, the role check still stops it being treated as a tenant.
  const wrongRole = jwt.sign({ email: 'a@b.com', orgId: '830', role: 'admin' }, TENANT_SECRET);
  const { payload, error } = verifyTenantToken(wrongRole, TENANT_SECRET);
  assert.equal(payload, undefined);
  assert.match(error, /not a tenant token/i);
});

test('the two cookie names are different', () => {
  assert.equal(TENANT_COOKIE, '__t_p');
  assert.notEqual(TENANT_COOKIE, '__s_t');
});

// ── refusing to run without a real secret ───────────────────────────────────

test('an unset tenant secret disables the portal rather than falling back', () => {
  const { secret, reason } = resolveTenantSecret({ tenantSecret: '', staffSecret: STAFF_SECRET });
  assert.equal(secret, null);
  assert.match(reason, /not set/i);
});

test('reusing the staff secret is refused', () => {
  // This is the original bug wearing a different variable name.
  const { secret, reason } = resolveTenantSecret({ tenantSecret: STAFF_SECRET, staffSecret: STAFF_SECRET });
  assert.equal(secret, null);
  assert.match(reason, /must differ/i);
});

test('a short secret is refused', () => {
  const { secret, reason } = resolveTenantSecret({ tenantSecret: 'short', staffSecret: STAFF_SECRET });
  assert.equal(secret, null);
  assert.match(reason, /too short/i);
});

test('whitespace does not sneak a match past the equality check', () => {
  const { secret } = resolveTenantSecret({ tenantSecret: `  ${STAFF_SECRET}  `, staffSecret: STAFF_SECRET });
  assert.equal(secret, null);
});

test('signing without a secret throws rather than producing a token', () => {
  assert.throws(() => signTenantToken({ email: 'a@b.com', orgId: '830' }, null), /refusing to sign/i);
});

// ── payload shape ───────────────────────────────────────────────────────────

test('a tenant token carries no staff identity', () => {
  const token = signTenantToken({ email: 'A@B.com', orgId: '830' }, TENANT_SECRET);
  const decoded = jwt.decode(token);
  assert.equal(decoded.role, 'tenant');
  assert.equal(decoded.email, 'a@b.com', 'email is normalised to lower case');
  for (const forbidden of ['userId', 'permissions', 'isMasterAdmin', 'isSuperAdmin', 'orgType']) {
    assert.ok(!(forbidden in decoded), `tenant token must not carry ${forbidden}`);
  }
});

test('a round trip preserves email, org and session generation, and nothing else', () => {
  const token = signTenantToken({ email: 'x@y.com', orgId: '8300127259922432', tokenVersion: 3 }, TENANT_SECRET);
  const { payload } = verifyTenantToken(token, TENANT_SECRET);
  assert.deepEqual(payload, { email: 'x@y.com', orgId: '8300127259922432', role: 'tenant', v: 3 });
});

test('a token with no session generation reads as 0, not NaN', () => {
  // Belt and braces for anything issued before token_version existed.
  const jwtLib = require('jsonwebtoken');
  const legacy = jwtLib.sign({ email: 'a@b.com', orgId: '830', role: 'tenant' }, TENANT_SECRET);
  assert.equal(verifyTenantToken(legacy, TENANT_SECRET).payload.v, 0);
});

test('the session generation survives signing so a reset can invalidate old cookies', () => {
  // The middleware compares this against tenant_portal_account.token_version, which is
  // incremented on every password change. A stolen cookie must not outlive the reset
  // that was prompted by the theft.
  const before = jwt.decode(signTenantToken({ email: 'a@b.com', orgId: '830', tokenVersion: 1 }, TENANT_SECRET));
  const after = jwt.decode(signTenantToken({ email: 'a@b.com', orgId: '830', tokenVersion: 2 }, TENANT_SECRET));
  assert.equal(before.v, 1);
  assert.equal(after.v, 2);
});

test('an expired tenant token is refused', () => {
  const expired = jwt.sign({ email: 'a@b.com', orgId: '830', role: 'tenant' }, TENANT_SECRET, { expiresIn: '-1s' });
  const { error } = verifyTenantToken(expired, TENANT_SECRET);
  assert.match(error, /invalid or expired/i);
});

test('a missing token is refused without throwing', () => {
  assert.match(verifyTenantToken(undefined, TENANT_SECRET).error, /authentication required/i);
});

test('no configured secret refuses every token', () => {
  const token = signTenantToken({ email: 'a@b.com', orgId: '830' }, TENANT_SECRET);
  assert.match(verifyTenantToken(token, null).error, /not configured/i);
});

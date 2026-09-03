const test = require('node:test');
const assert = require('node:assert');
const {
  TOKEN_TTL_MINUTES, MIN_PASSWORD_LENGTH, sha256,
  createRegistrationToken, parseRegistrationToken, passwordProblem, normaliseEmail,
} = require('../src/utils/tenantPortalRegistration');

// ── token round trip ────────────────────────────────────────────────────────

test('a token round-trips to the org that issued it', () => {
  const orgId = '8300127259922432';
  const { token, secretHash } = createRegistrationToken(orgId);
  const parsed = parseRegistrationToken(token);
  assert.equal(parsed.orgId, orgId);
  assert.equal(parsed.secretHash, secretHash);
});

test('only the hash is ever stored, never the emailed secret', () => {
  const { token, secretHash } = createRegistrationToken('830');
  const secret = token.split('.')[1];
  assert.equal(secretHash, sha256(secret));
  assert.notEqual(secretHash, secret);
  assert.equal(secretHash.length, 64);
});

test('two tokens for the same org never collide', () => {
  const a = createRegistrationToken('830');
  const b = createRegistrationToken('830');
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.secretHash, b.secretHash);
});

test('a token names its org so the click can find the right database', () => {
  // There is no session when someone clicks the emailed link, so nothing else says
  // which org's database holds the pending registration.
  const { token } = createRegistrationToken('1785147765338802507');
  assert.equal(parseRegistrationToken(token).orgId, '1785147765338802507');
});

// ── malformed input must be bland, never explosive ──────────────────────────

test('garbage from a query string returns null rather than throwing', () => {
  for (const junk of [undefined, null, 42, {}, [], '', '.', 'abc', 'abc.', '.abc',
                      'not-base64.deadbeef', 'ODMw.tooshort', 'ODMw.' + 'z'.repeat(64)]) {
    assert.doesNotThrow(() => parseRegistrationToken(junk));
    assert.equal(parseRegistrationToken(junk), null, `should reject: ${String(junk)}`);
  }
});

test('a non-numeric org in the token is refused', () => {
  const orgPart = Buffer.from('DROP TABLE tenant', 'utf8').toString('base64url');
  assert.equal(parseRegistrationToken(`${orgPart}.${'a'.repeat(64)}`), null);
});

test('the secret half must be exactly 64 hex characters', () => {
  const orgPart = Buffer.from('830', 'utf8').toString('base64url');
  assert.equal(parseRegistrationToken(`${orgPart}.${'a'.repeat(63)}`), null);
  assert.equal(parseRegistrationToken(`${orgPart}.${'a'.repeat(65)}`), null);
  assert.equal(parseRegistrationToken(`${orgPart}.${'g'.repeat(64)}`), null, 'g is not hex');
  assert.ok(parseRegistrationToken(`${orgPart}.${'a'.repeat(64)}`));
});

test('an org id is required to create a token', () => {
  assert.throws(() => createRegistrationToken(''), /must name an org/i);
  assert.throws(() => createRegistrationToken(null), /must name an org/i);
});

test('the link is short-lived', () => {
  assert.ok(TOKEN_TTL_MINUTES > 0 && TOKEN_TTL_MINUTES <= 120,
    'a set-password link should last minutes, not days');
});

// ── passwords ───────────────────────────────────────────────────────────────

test('a short password is refused and says the floor', () => {
  const problem = passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1));
  assert.match(problem, new RegExp(String(MIN_PASSWORD_LENGTH)));
});

test('a long passphrase is accepted with no composition rules', () => {
  // Deliberate: pushing tenants toward "Summer2026!" is worse than a long simple phrase.
  assert.equal(passwordProblem('correct horse battery staple'), null);
});

test('a non-string password is refused rather than coerced', () => {
  for (const junk of [undefined, null, 12345678901, {}, []]) {
    assert.ok(passwordProblem(junk), `should reject ${String(junk)}`);
  }
});

test('an absurdly long password is refused, since bcrypt would hash it anyway', () => {
  assert.ok(passwordProblem('a'.repeat(201)));
});

// ── emails ──────────────────────────────────────────────────────────────────

test('emails are lower-cased and trimmed', () => {
  assert.equal(normaliseEmail('  MiXeD@Case.COM  '), 'mixed@case.com');
});

test('obvious rubbish is refused', () => {
  for (const junk of [undefined, null, '', 'a', 'no-at-sign', 'a@b', 'a@b.', '@b.com', 'a b@c.com']) {
    assert.equal(normaliseEmail(junk), null, `should reject: ${String(junk)}`);
  }
});

test('a plus-addressed and a long-TLD address are accepted', () => {
  // Being strict here locks real tenants out of their own portal, which is worse than
  // sending one email to an address that bounces.
  assert.equal(normaliseEmail('tenant+portal@example.technology'), 'tenant+portal@example.technology');
});

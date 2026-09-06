/**
 * The registration screens.
 *
 * Source assertions, for the same reason as tenantPortalClientSession.test.js: the portal
 * frontend has no test harness, and the failures worth catching here are ones that read
 * fine in review. Two of them matter more than the rest — a password floor that drifts
 * from the server's, and a page that softens the deliberately non-committal answer the
 * register endpoint gives.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const REGISTER = '../../frontend/src/app/tenant-portal/register/page.js';
const SET_PASSWORD = '../../frontend/src/app/tenant-portal/set-password/page.js';
const LOGIN = '../../frontend/src/app/tenant-portal/login/page.js';

const { MIN_PASSWORD_LENGTH } = require('../src/utils/tenantPortalRegistration');

// ── the pages exist and are reachable ───────────────────────────────────────

test('both registration pages exist at the paths the emailed link and the client use', () => {
  // The link mailed to a tenant is built server-side as
  // `${appUrl}/tenant-portal/set-password?token=...`. If that route does not exist, the
  // email is a 404 and there is no second chance to send it.
  const linkPath = read('../src/routes/tenantPortal.js').match(/\/tenant-portal\/set-password\?token=/);
  assert.ok(linkPath, 'the register email no longer points at /tenant-portal/set-password');
  assert.ok(fs.existsSync(path.join(__dirname, SET_PASSWORD)), 'set-password page is missing');
  assert.ok(fs.existsSync(path.join(__dirname, REGISTER)), 'register page is missing');
});

test('the sign-in page offers a way to reach registration', () => {
  // Without this link the register page is unreachable: nothing else in the portal
  // points at it, and a tenant with no account cannot get past the login screen to
  // find it.
  const code = stripComments(read(LOGIN));
  assert.match(code, /href=["']\/tenant-portal\/register["']/);
});

// ── the password floor must not drift from the server's ─────────────────────

test('the set-password form uses the same minimum length the server enforces', () => {
  // A frontend floor BELOW the server's rejects nothing and hands the tenant a server
  // error after they have typed twice. A floor ABOVE it refuses passwords the server
  // would have accepted. Either way the tenant is told something untrue.
  const code = stripComments(read(SET_PASSWORD));
  const declared = code.match(/const\s+MIN_PASSWORD_LENGTH\s*=\s*(\d+)/);
  assert.ok(declared, 'set-password page does not declare MIN_PASSWORD_LENGTH');
  assert.equal(
    Number(declared[1]),
    MIN_PASSWORD_LENGTH,
    `frontend minimum (${declared[1]}) differs from the server's (${MIN_PASSWORD_LENGTH})`
  );
});

test('the set-password form invents no composition rules', () => {
  // passwordProblem() checks length and nothing else. A "must contain a number" rule
  // added only in the browser would be a rule the server does not have, and the usual
  // result of one is Summer2026!.
  const code = stripComments(read(SET_PASSWORD));
  assert.ok(!/uppercase|lowercase|special char|[^a-z]digit/i.test(code),
    'set-password page is enforcing composition rules the server does not');
});

// ── the register acknowledgement must stay non-committal ────────────────────

test('the register page shows the server acknowledgement rather than its own', () => {
  // POST /register answers identically for a real tenant, a stranger, and its own
  // internal failure, so the endpoint cannot be used to test whether an address belongs
  // to a tenant. A page that replaced that with "Check your inbox, we sent it!" would
  // give the answer back, because it only reaches that branch on the real path.
  const code = stripComments(read(REGISTER));
  assert.match(code, /response\.data\?\.message/,
    'register page is not rendering the server message');
});

test('the register page replaces the form once a link is sent', () => {
  // A second submit issues a second token and invalidates the first, so the link the
  // tenant is walking to their inbox to fetch stops working.
  const code = stripComments(read(REGISTER));
  assert.match(code, /sent\s*\?/, 'register page still shows the form after sending');
});

// ── the completion request ──────────────────────────────────────────────────

test('set-password submits the token with the password', () => {
  const code = stripComments(read(SET_PASSWORD));
  assert.match(code, /completeRegistration\(\{\s*token,\s*password:/);
});

test('the confirm field never leaves the browser', () => {
  // /register/complete takes { token, password }. Sending a confirm field would be a
  // second copy of the password in the request body for no reason.
  const code = stripComments(read(SET_PASSWORD));
  assert.ok(!/confirm:\s*values/.test(code), 'the confirmation copy is being sent to the server');
  assert.match(code, /getFieldValue\('password'\)\s*===\s*value/);
});

test('set-password handles a missing token without offering a form', () => {
  // Email clients truncate long links. Presenting a password form that cannot possibly
  // succeed wastes the attempt and reads as the portal being broken.
  const code = stripComments(read(SET_PASSWORD));
  assert.match(code, /if\s*\(!token\)/);
});

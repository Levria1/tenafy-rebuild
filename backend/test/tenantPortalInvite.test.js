/**
 * Somebody has to be able to invite a tenant onto the portal.
 *
 * The portal has been live and reachable, with ONE account on it against 114
 * tenants holding a live lease, because the only way in was for a tenant to find
 * the portal themselves and ask for a link. The Invite button on the Tenants list
 * called message.info('Invite feature coming soon') and did nothing.
 *
 * Two triggers now start the same journey — confirming a lease, and that button —
 * and self-service registration was refactored onto the same code so the three
 * cannot drift into three different emails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Line comments FIRST, or a "/*" inside one opens a phantom block comment.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── one implementation, three callers ───────────────────────────────────────

test('all three triggers go through the shared invite helper', () => {
  for (const rel of ['../src/routes/tenantPortal.js', '../src/routes/tenant.js', '../src/routes/leasing.js']) {
    const src = stripComments(read(rel));
    assert.match(src, /require\('\.\.\/utils\/tenantPortalInvite'\)/, `${rel} must use the shared helper`);
    assert.match(src, /prepareInvite\(/, `${rel} must call it`);
  }
});

test('self-service registration no longer builds its own token and email', () => {
  // Two implementations of a credential-bearing email is how a fix lands on one
  // path and quietly misses the other.
  const src = stripComments(read('../src/routes/tenantPortal.js'));
  assert.doesNotMatch(src, /registrationEmail\(\{ brand/,
    'the wording must come from the shared helper');
  assert.doesNotMatch(src, /INSERT INTO tenant_portal_account/,
    'the token row must be written in one place only');
});

test('the helper prepares the message rather than sending it', () => {
  // The two callers need OPPOSITE behaviour on the way out and that is deliberate,
  // so the send stays with the caller.
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.doesNotMatch(src, /await sendMail\(/, 'the helper must not send');
  assert.match(src, /message: \{ to: address, from: accountSender\(\)/);
});

// ── the security posture of each caller ─────────────────────────────────────

test('registration still gives the same answer whatever happened', () => {
  // It must not become an oracle telling anyone which addresses belong to tenants.
  const src = stripComments(read('../src/routes/tenantPortal.js'));
  const at = src.indexOf("router.post('/register'");
  const block = src.slice(at, src.indexOf("router.post('/register/complete'"));
  assert.match(block, /if \(!prepared\.ok\) return res\.json\(REGISTER_ACK\)/,
    'a refusal must be indistinguishable from a send');
  assert.doesNotMatch(block, /prepared\.detail/, 'and must never leak the reason');
  assert.match(block, /sendMail\(prepared\.message\)\s*\n?\s*\.catch/,
    'the send is not awaited, so timing does not answer the question either');
});

test('the staff invite answers honestly instead', () => {
  // Someone pressed a button. "No email address on file" is the whole point.
  const src = stripComments(read('../src/routes/tenant.js'));
  const at = src.indexOf("router.post('/:id/portal-invite'");
  assert.ok(at > -1, 'the endpoint must exist');
  const block = src.slice(at, at + 2600);
  assert.match(block, /requirePermission\('LANDLORD\/TENANT_PORTAL_INVITE', 'LANDLORD\/TENANT_EDIT'\)/);
  assert.match(block, /prepared\.detail/, 'the refusal reason is reported');
  assert.match(block, /await sendMail\(prepared\.message\)/, 'awaited, so the result is known');
  assert.match(block, /FROM tenant WHERE id = \? AND org_id = \?/, 'org-scoped lookup');
  assert.match(block, /logActivity\(req, 'EMAIL', 'tenant'/);
});

test('the invite endpoint refuses when the portal is not configured', () => {
  const src = stripComments(read('../src/routes/tenant.js'));
  const at = src.indexOf("router.post('/:id/portal-invite'");
  const block = src.slice(at, at + 800);
  assert.match(block, /tenantPortalEnabled\(\)[\s\S]{0,200}503/,
    'a set-password link is useless if the portal cannot serve it');
});

// ── eligibility ─────────────────────────────────────────────────────────────

test('the invite applies the same eligibility rule as registration', () => {
  // 2,945 of the 4,785 contact rows are payees and 3,060 have no lease. Without
  // this the Invite button would hand portal access to a contractor or a prospect.
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /isEligibleToRegister\(pool, orgId, address\)/);
  assert.match(src, /reason: 'not_eligible'/);
});

test('a contact with no email is refused with a reason, not silently', () => {
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /if \(!address\) return \{ ok: false, reason: 'no_email'/);
  const reasons = read('../src/utils/tenantPortalInvite.js');
  assert.match(reasons, /no_email: 'This contact has no email address on file\.'/);
});

test('the token row is written with update-then-insert, not ON DUPLICATE KEY', () => {
  // ODKU fires on ANY unique clash including the PRIMARY KEY. Two Snowflakes in the
  // same millisecond collide at 1e-6, and on such a collision ODKU would write this
  // invitation's token onto someone else's account row — an account takeover.
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.doesNotMatch(src, /ON DUPLICATE KEY UPDATE/);
  assert.match(src, /UPDATE tenant_portal_account\s*\n?\s*SET verify_token_hash/);
  assert.match(src, /upd\.affectedRows === 0/);
  assert.match(src, /ER_DUP_ENTRY/, 'and the race between the UPDATE and the INSERT is handled');
});

test('the email is signed by the org, never a hardcoded name', () => {
  // Three orgs share this codebase.
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /registrationEmail\(\{ brand: orgName, link \}\)/);
  assert.doesNotMatch(src, /Tane Residence/);
});

// ── lease confirmation ──────────────────────────────────────────────────────

test('confirming a lease sends the invite SEPARATELY from the check-in email', () => {
  const src = stripComments(read('../src/routes/leasing.js'));
  assert.match(src, /async function invitePortal\(pool, orgId, leaseId, tenantEmail, tenantName\)/);
  const at = src.indexOf("router.post('/:id/confirm'");
  const block = src.slice(at);
  const checkinAt = block.indexOf('maybeSendCheckin(req.pool');
  const inviteAt = block.indexOf('invitePortal(req.pool');
  assert.ok(checkinAt > -1 && inviteAt > checkinAt,
    'both are sent, and the invite is its own message');
});

test('a failed invite cannot undo a confirmed lease', () => {
  // Confirming creates invoices and blocks the calendar. A mail server having a bad
  // minute must not roll any of that back.
  const src = read('../src/routes/leasing.js');
  const at = src.indexOf('async function invitePortal');
  const block = src.slice(at, at + 1600);
  assert.match(block, /try \{/);
  assert.match(block, /catch \(err\)/);
  assert.doesNotMatch(block, /throw /, 'it must swallow its own failures');
  const src2 = stripComments(read('../src/routes/leasing.js'));
  assert.doesNotMatch(src2, /await invitePortal\(/, 'and not be awaited by the request');
});

test('no email address means no attempt', () => {
  const src = stripComments(read('../src/routes/leasing.js'));
  const at = src.indexOf('async function invitePortal');
  const block = src.slice(at, at + 400);
  assert.match(block, /if \(!tenantEmail\) return;/);
  assert.match(block, /if \(!tenantPortalEnabled\(\)\) return;/);
});

// ── the button ──────────────────────────────────────────────────────────────

test('the Invite button actually calls the endpoint now', () => {
  const src = stripComments(read('../../frontend/src/app/contacts/tenants/page.js'));
  assert.doesNotMatch(src, /Invite feature coming soon/);
  assert.match(src, /tenantApi\.sendPortalInvite\(t\.id\)/);
  assert.match(src, /err\.response\?\.data\?\.message/, 'and reports the real reason');
});

test('the button names the address before sending a credential link', () => {
  const src = stripComments(read('../../frontend/src/app/contacts/tenants/page.js'));
  assert.match(src, /<Popconfirm/);
  assert.match(src, /They will get a link to set a password, sent to/);
  assert.match(src, /No email address on file for this contact/,
    'and is disabled outright when there is nowhere to send it');
});

test('the desktop row and the mobile card share one invite control', () => {
  // Two copies of a confirmation dialog is two places for it to be wrong.
  const src = stripComments(read('../../frontend/src/app/contacts/tenants/page.js'));
  assert.match(src, /function InviteButton\(\{ data, onInvite, busy, icon = null, allowed = true \}\)/);
  assert.strictEqual((src.match(/<InviteButton/g) || []).length, 2);
});

test('the Confirm Lease dialog says a portal invitation goes out', () => {
  // It already had to be corrected once for not mentioning the check-in email.
  const src = stripComments(read('../../frontend/src/app/leasing/[id]/detail/page.js'));
  assert.match(src, /Invite the tenant to the portal/);
  assert.match(src, /a separate email with a link to set a password/);
});

// ── the legacy invite is gone ────────────────────────────────────────────────

test('the old contact.js tenant invite endpoints no longer exist', () => {
  // They mailed an invite code that went into user_verification_token, against a row
  // in the STAFF `user` table. The portal authenticates on
  // tenant_portal_account.verify_token_hash and has no idea either table exists, so
  // the code could never be redeemed and each attempt left a passwordless staff row.
  const src = stripComments(read('../src/routes/contact.js'));
  assert.doesNotMatch(src, /router\.post\('\/tenant\/check\/user'/);
  assert.doesNotMatch(src, /router\.post\('\/tenant\/create\/user'/);
  assert.doesNotMatch(src, /You have been invited to the tenant portal/);
  // NOT a blanket check on user_verification_token: the property-owner invite is a
  // separate feature that still writes to it. Scoped to the tenant path only.
  assert.doesNotMatch(src, /UPDATE tenant SET user_id = \?/);
});

test('the property-owner portal routes were left alone', () => {
  // A different feature that happens to sit in the same section of the file.
  const src = stripComments(read('../src/routes/contact.js'));
  assert.match(src, /router\.post\('\/property-owner\/check\/user'/);
  assert.match(src, /router\.post\('\/property-owner\/create\/user'/);
});

test('the api client no longer offers the removed endpoints', () => {
  const src = stripComments(read('../../frontend/src/lib/api.js'));
  assert.doesNotMatch(src, /checkTenantUser|createTenantUser/);
  assert.match(src, /sendPortalInvite: \(id\) =>/, 'the working one is there instead');
});

test('a tombstone explains why, so nobody puts it back', () => {
  const src = read('../src/routes/contact.js');
  assert.match(src, /has been REMOVED/);
  assert.match(src, /POST \/api\/tenant\/:id\/portal-invite/, 'and points at the replacement');
});

// ── its own permission (owner, 2026-11-04) ──────────────────────────────────

test('Send Portal Invite is its own permission, offered on the Roles page and to new orgs', () => {
  assert.match(read('../src/routes/role.js'), /key: 'LANDLORD\/TENANT_PORTAL_INVITE', label: 'Send Portal Invite', group: 'Tenants'/);
  assert.match(read('../src/services/orgProvisioner.js'), /'LANDLORD\/TENANT_PORTAL_INVITE'/);
});

test('the Tenants list disables Invite for a role that cannot send it, by the same rule as the server', () => {
  const page = read('../../frontend/src/app/contacts/tenants/page.js');
  assert.match(page, /hasPermission\('LANDLORD\/TENANT_PORTAL_INVITE'\) \|\| hasPermission\('LANDLORD\/TENANT_EDIT'\)/);
  assert.equal((page.match(/allowed=\{canInvite\}/g) || []).length, 2, 'desktop and mobile rows');
  assert.equal((page.match(/canInvite=\{canInvite\}/g) || []).length, 2);
});

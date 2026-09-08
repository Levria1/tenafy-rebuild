/**
 * Account and security email must not come from the billing address.
 *
 * A password reset or a set-your-password link arriving from the address that invoices
 * people trains the habit phishing depends on: trust a payment-adjacent sender carrying
 * a credential link. These tests pin which emails carry the separate sender, and that an
 * unconfigured deployment still sends rather than failing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── the helper itself ───────────────────────────────────────────────────────

test('an unset sender falls back rather than breaking the send', () => {
  // A deployment that has not set EMAIL_FROM_ACCOUNT must keep sending exactly as
  // before. Returning '' instead of undefined would put an empty From on the message.
  //
  // Set to empty rather than deleted. Re-requiring config re-runs dotenv, which reads a
  // deleted variable straight back out of .env, so `delete` tested nothing on any
  // machine that actually has the variable configured. It passed locally only because
  // this developer's .env does not set it.
  process.env.EMAIL_FROM_ACCOUNT = '';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/config/mailer')];
  const { accountSender } = require('../src/config/mailer');
  assert.equal(accountSender(), undefined);
});

test('a configured sender is used verbatim', () => {
  process.env.EMAIL_FROM_ACCOUNT = 'Example <no-reply@example.com>';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/config/mailer')];
  const { accountSender } = require('../src/config/mailer');
  assert.equal(accountSender(), 'Example <no-reply@example.com>');
  process.env.EMAIL_FROM_ACCOUNT = '';
});

test('no address is hardcoded as the default', () => {
  // This is a multi-tenant product. A literal fallback address would make one customer's
  // domain the sender for every other customer's account email.
  const cfg = stripComments(read('../src/config/index.js'));
  const line = cfg.match(/emailFromAccount:.*/);
  assert.ok(line, 'emailFromAccount is gone from config');
  assert.ok(!/@/.test(line[0]), 'an email address is hardcoded as the account sender default');
});

// ── every account email must carry it ───────────────────────────────────────

const CASES = [
  ['../src/routes/auth.js', 'password reset', /const mailOpts = \{ to: toEmail[^}]*from: accountSender\(\)/],
  ['../src/routes/auth.js', 'activation code', /subject: 'Your activation code'[\s\S]{0,200}?from: accountSender\(\)/],
  // The subject now lives in utils/registrationEmail.js, so this anchors on the send
  // itself rather than on wording that is free to change.
  // Moved to utils/tenantPortalInvite.js, now shared by self-service registration,
  // the Invite button on the Tenants list, and lease confirmation. The message is
  // built there and sent by the caller, so the sender is asserted where it is set.
  ['../src/utils/tenantPortalInvite.js', 'portal registration link', /message: \{ to: address, from: accountSender\(\), subject, text, html \}/],
  ['../src/routes/contact.js', 'tenant portal invite', /from: accountSender\(\)[\s\S]{0,120}?invited to the tenant portal/],
  ['../src/routes/contact.js', 'owner portal invite', /from: accountSender\(\)[\s\S]{0,120}?invited to the property owner portal/],
];

for (const [file, label, pattern] of CASES) {
  test(`the ${label} email uses the account sender`, () => {
    assert.match(stripComments(read(file)), pattern);
  });
}

test('the account sender reaches the org-SMTP path too', () => {
  // The password reset picks a per-org SMTP account when one exists. Building mailOpts
  // once, before that branch, is what stops the sender applying to only half the cases.
  const src = stripComments(read('../src/routes/auth.js'));
  const fn = src.slice(src.indexOf('async function sendResetCodeEmail'), src.indexOf('// Helper: look up org pool'));
  const optsAt = fn.indexOf('const mailOpts');
  const branchAt = fn.indexOf('sendMailWithAccount');
  assert.ok(optsAt > -1 && branchAt > optsAt,
    'mailOpts is built after the SMTP branch, so the sender would apply to only one path');
});

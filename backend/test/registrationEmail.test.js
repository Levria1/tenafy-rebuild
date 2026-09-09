/**
 * The registration email.
 *
 * It arrives unprompted, carries a link, and asks the reader to set a password, which is
 * the exact shape of a phishing email. So the things tested here are the things that make
 * it survive a sceptical read, plus the multi-tenancy rule that no customer's name may be
 * baked in.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { registrationEmail, WHAT_YOU_CAN_DO } = require('../src/utils/registrationEmail');
const { TOKEN_TTL_MINUTES } = require('../src/utils/tenantPortalRegistration');

const LINK = 'https://platform.tenafy.com/tenant-portal/set-password?token=ODMwMA.abc123';
const build = (brand = 'Tane Residence') => registrationEmail({ brand, link: LINK });

// ── subject ─────────────────────────────────────────────────────────────────

test('the subject names the organisation, the task and the product', () => {
  assert.equal(build().subject, 'Tane Residence: Set up your tenant portal password on Tenafy');
});

test('the subject is built from the organisation passed in', () => {
  assert.equal(build('Alex Kot').subject, 'Alex Kot: Set up your tenant portal password on Tenafy');
});

// ── multi-tenancy ───────────────────────────────────────────────────────────

test('no customer name is hardcoded anywhere in the module', () => {
  // Three organisations share this deployment. A literal here would sign every other
  // customer's email as Tane Residence.
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/registrationEmail.js'), 'utf8');
  assert.ok(!/Tane|Residence/i.test(src), 'a customer name is hardcoded in the email module');
});

test('a missing organisation name still produces a sendable email', () => {
  // display_name is nullable in master. An email addressed by "undefined" is worse than
  // a generic one.
  for (const empty of [undefined, null, '', '   ']) {
    const { subject, text, html } = registrationEmail({ brand: empty, link: LINK });
    assert.ok(!/undefined|null/.test(subject + text + html), `leaked a placeholder for ${JSON.stringify(empty)}`);
    assert.match(subject, /^Your property manager: /);
  }
});

// ── the things that make it credible ────────────────────────────────────────

test('both versions carry the link', () => {
  const { text, html } = build();
  assert.ok(text.includes(LINK));
  assert.ok(html.includes(LINK));
});

test('the expiry is stated, and matches the token the server actually issues', () => {
  // "This link expires shortly" is not actionable. It also has to be TRUE: the wording
  // reads the same constant the token is minted with.
  //
  // Stated in words rather than minutes since the lifetime became 7 days. The raw
  // number is still correct and completely useless to a reader: "this link expires
  // in 10080 minutes".
  const { TOKEN_TTL_LABEL } = require('../src/utils/tenantPortalRegistration');
  const { text, html } = build();
  assert.ok(text.includes(`expires in ${TOKEN_TTL_LABEL}`));
  assert.ok(html.includes(`expires in ${TOKEN_TTL_LABEL}`));
  assert.ok(!text.includes(String(TOKEN_TTL_MINUTES)), 'not the raw minute count');
});

test('it tells a reader who did not request it what to do', () => {
  const { text, html } = build();
  for (const body of [text, html]) assert.match(body, /did not request this/i);
});

test('it says the sending address is unmonitored', () => {
  // It is sent from no-reply. Someone who replies with a question would otherwise be
  // waiting on an answer that can never come.
  const { text, html } = build();
  for (const body of [text, html]) assert.match(body, /not monitored/i);
});

test('both versions list what the portal is actually for', () => {
  const { text, html } = build();
  for (const item of WHAT_YOU_CAN_DO) {
    assert.ok(text.includes(item), `plain text is missing: ${item}`);
    assert.ok(html.includes(item), `html is missing: ${item}`);
  }
});

test('a plain-text alternative exists and contains no markup', () => {
  // Sent as the text/plain part. Markup leaking into it is what makes an email look
  // broken in clients that prefer plain text.
  const { text } = build();
  assert.ok(text.length > 200);
  assert.ok(!/<[a-z/][^>]*>/i.test(text), 'HTML tags leaked into the plain-text version');
});

// ── injection ───────────────────────────────────────────────────────────────

test('an organisation name cannot inject markup into the html', () => {
  // display_name is set by an administrator, not the public, so this is defence in
  // depth rather than a live hole. It costs one escape function.
  const { html } = registrationEmail({ brand: '<script>alert(1)</script>Acme', link: LINK });
  assert.ok(!html.includes('<script>'), 'organisation name is interpolated unescaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

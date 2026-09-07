/**
 * The manual "send check-in email" button.
 *
 * It deliberately overrides timing: staff need to resend, or send early. It must not
 * override whether the tenancy exists. Every automatic path already refused an
 * unconfirmed lease; this button did not, which made it the only route by which check-in
 * instructions could reach a lease nobody had confirmed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LEASING = stripComments(read('../src/routes/leasing.js'));
const EMAIL_SERVICE = stripComments(read('../src/services/emailService.js'));

const manualSend = () => {
  const at = LEASING.indexOf('Manual check-in email error');
  assert.ok(at > -1, 'the manual check-in endpoint is gone');
  // Walk back to the route that owns that catch block.
  const start = LEASING.lastIndexOf("router.post(", at - 3000 > 0 ? at - 3000 : 0);
  return LEASING.slice(start, at);
};

test('the manual send refuses a lease that is not active', () => {
  const code = manualSend();
  assert.match(code, /l\.lease_state/, 'the endpoint does not even read the lease state');
  assert.match(code, /lease\.lease_state !== 'active'/);
  assert.match(code, /Confirm the lease first/i);
});

test('the manual send still overrides the toggle and the date window', () => {
  // That is what the button is for. Only the state gate was added.
  const code = manualSend();
  assert.ok(!/tenant_checkin = 1/.test(code), 'the manual send now also enforces the toggle');
  assert.ok(!/isWithinCheckinWindow/.test(code), 'the manual send now also enforces the window');
});

test('the manual send is recorded against the lease', () => {
  // Tracing one tenant's check-in email meant inferring the cause from email_log
  // timestamps, because neither this button nor confirm left any record of who acted.
  assert.match(manualSend(), /logActivity\(req, 'EMAIL', 'lease', id/);
});

test('confirming a lease is recorded', () => {
  const at = LEASING.indexOf("message: 'Lease confirmed'");
  assert.ok(at > -1);
  assert.match(LEASING.slice(at - 400, at), /logActivity\(req, 'CONFIRM', 'lease', id/);
});

// ── which template is "the default" ─────────────────────────────────────────

test('the default template is chosen deterministically', () => {
  // Tane has eight active Checkin-Tenant templates and all eight are flagged default.
  // With a bare LIMIT 1 the row returned is arbitrary and can change after any write,
  // and it decides both the lead time and the wording. Seven of the eight have a lead
  // time of 0 and several have an empty subject.
  const at = EMAIL_SERVICE.indexOf('async function loadTemplate');
  const fn = EMAIL_SERVICE.slice(at, at + 1200);
  const defaultQuery = fn.slice(fn.indexOf('is_default_template = 1'));
  assert.match(defaultQuery, /ORDER BY created_at DESC, id DESC/,
    'the default template is picked with no tie-breaker');
});

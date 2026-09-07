/**
 * Confirming a lease must say that it emails the tenant.
 *
 * The dialog listed two of the three things confirming does. The missing one is the only
 * one that leaves the building: a lease confirmed before the tenant had signed sent them
 * move-in instructions for a flat still being negotiated, and the person clicking had no
 * way to know. Invoices can be deleted; an email cannot be recalled.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '../../frontend/src/app/leasing/[id]/detail/page.js'), 'utf8');

const dialog = () => {
  const at = PAGE.indexOf('title="Confirm this lease?"');
  assert.ok(at > -1, 'the confirm dialog is gone');
  return PAGE.slice(at, PAGE.indexOf('</Popconfirm>', at));
};

test('the dialog says check-in details will be emailed', () => {
  assert.match(dialog(), /Email check-in details to the tenant/i);
});

test('the dialog names the address it will go to', () => {
  // "an email will be sent" is not actionable. Seeing the address is what makes someone
  // notice it is going to the wrong person, or to someone who has not signed.
  assert.match(dialog(), /lease\?\.tenant_email/);
});

test('the dialog still says what it always said', () => {
  const d = dialog();
  assert.match(d, /invoices/i);
  assert.match(d, /Mark the lease active/i);
});

test('the warning is suppressed when no email will go', () => {
  // A lease with check-in disabled, or a tenant with no address, sends nothing. Claiming
  // otherwise trains people to ignore the warning.
  assert.match(dialog(), /willEmailCheckin &&/);
  assert.match(PAGE, /const willEmailCheckin = checkinEnabled && Boolean\(lease\?\.tenant_email\)/);
});

test('the toggle is read defensively', () => {
  // tenant_checkin is a MySQL bit(1) and arrives over JSON as a number, a boolean or a
  // Buffer-shaped object. Warning about an email that does not send is harmless; staying
  // silent about one that does is the failure this exists to prevent.
  const decl = PAGE.slice(PAGE.indexOf('const checkinToggle'), PAGE.indexOf('const willEmailCheckin'));
  assert.match(decl, /=== 0/);
  assert.match(decl, /=== false/);
  assert.match(decl, /== null/);
});

test('the banner above the button says it too', () => {
  // Someone who clicks straight through the dialog still reads the banner.
  const at = PAGE.indexOf('This lease is a draft');
  assert.match(PAGE.slice(at, at + 500), /confirming also emails check-in details/i);
});

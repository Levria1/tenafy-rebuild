/**
 * WhatsApp and email are separate per-lease choices (owner, 2026-11-04).
 *
 * Before this, a tenant WhatsApp went out only as a side effect of the email, so
 * unticking "Email tenant when invoice is overdue" silenced the WhatsApp too, and a
 * tenant with a phone but no email got nothing at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── stubs: no real mail, no real WhatsApp ───────────────────────────────────
const mailed = [];
const waCalls = [];
function stub(rel, exports) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../src/config/mailer', {
  sendMail: async (opts) => { mailed.push(opts); return { messageId: 'm1' }; },
  sendMailWithAccount: async (_a, opts) => { mailed.push(opts); return { messageId: 'm1' }; },
});
stub('../src/services/whatsappService', {
  sendTemplateWhatsApp: async (_pool, _org, opts) => { waCalls.push(opts); return { ok: true, waMessageId: 'w1' }; },
});
const { sendOverdueToTenant, sendCheckinFollowUpToTenant, hasEmailBeenSent } = require('../src/services/emailService');

function fakePool({ email, wa, tenantEmail = 'tenant@example.com', sentCount = 0 }) {
  const seen = [];
  return {
    seen,
    async execute(sql, params) {
      seen.push(sql);
      if (/SELECT `tenant_overdue` AS toggled|SELECT `tenant_checkin` AS toggled/.test(sql)) return [[{ toggled: email ? 1 : 0 }]];
      if (/SELECT `wa_tenant_overdue` AS toggled|SELECT `wa_tenant_checkin` AS toggled/.test(sql)) return [[{ toggled: wa ? 1 : 0 }]];
      if (/FROM email_template/.test(sql)) return [[{ id: 't1', subject: 'Overdue', template_content: 'Please pay', status: 1, is_default_template: 1 }]];
      if (/SELECT t\.email FROM tenant t/.test(sql)) return [[{ email: tenantEmail }]];
      if (/AS cnt/.test(sql)) return [[{ cnt: sentCount }]];
      return [[]];
    },
  };
}

test('email off, WhatsApp on: the WhatsApp still goes, no email', async () => {
  mailed.length = 0; waCalls.length = 0;
  const pool = fakePool({ email: false, wa: true });
  const r = await sendOverdueToTenant(pool, 'org1', 'L1', { overdueAmount: 500, invoiceCode: 'TRIV1', category: 'c1' });
  assert.equal(waCalls.length, 1);
  assert.equal(waCalls[0].templateType, 'Overdue-Tenant');
  assert.equal(waCalls[0].overdueAmount, 500, 'the WhatsApp quotes what is owed');
  assert.equal(mailed.length, 0);
  assert.ok(!pool.seen.some(q => /FROM email_template/.test(q)), 'the email path is not even started');
  assert.ok(r && r.whatsapp, 'a WhatsApp-only send counts as sent, not skipped');
});

test('email on, WhatsApp off: no WhatsApp rides along with the email any more', async () => {
  mailed.length = 0; waCalls.length = 0;
  const pool = fakePool({ email: true, wa: false });
  await sendOverdueToTenant(pool, 'org1', 'L1', { overdueAmount: 500 });
  await new Promise(r => setImmediate(r));
  assert.equal(mailed.length, 1, 'the email went');
  assert.equal(waCalls.length, 0);
});

test('both off: nothing is sent and the sweep sees a skip', async () => {
  mailed.length = 0; waCalls.length = 0;
  const r = await sendOverdueToTenant(fakePool({ email: false, wa: false }), 'org1', 'L1', {});
  assert.equal(r, null);
  assert.equal(waCalls.length + mailed.length, 0);
});

test('the check-in follow-up logs its WhatsApp under its own type', async () => {
  waCalls.length = 0;
  await sendCheckinFollowUpToTenant(fakePool({ email: false, wa: true }), 'org1', 'L1');
  assert.equal(waCalls[0].templateType, 'Checkin-Tenant');
  assert.equal(waCalls[0].logType, 'Checkin-Tenant-2', 'or the two legs could not dedup separately');
});

test('"already sent" counts WhatsApp, so a WhatsApp-only lease is not messaged every morning', async () => {
  const pool = fakePool({ sentCount: 1 });
  assert.equal(await hasEmailBeenSent(pool, 'L1', 'Checkout-Tenant'), true);
  assert.ok(pool.seen.some(q => /FROM whatsapp_log/.test(q)));
});

// ── wiring ──────────────────────────────────────────────────────────────────
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('migration adds six WhatsApp columns and copies the email ticks only once', () => {
  const sql = read('../migrations-org/085_lease_whatsapp_toggles.sql');
  for (const c of ['wa_tenant_posted', 'wa_tenant_overdue', 'wa_tenant_deposit_posted', 'wa_tenant_checkin', 'wa_tenant_checkout', 'wa_tenant_renewal']) {
    assert.match(sql, new RegExp(`ADD COLUMN ${c} TINYINT\\(1\\) NOT NULL DEFAULT 0`));
  }
  assert.match(sql, /SET @sql := IF\(@added,\s*'UPDATE leasing SET/, 'the backfill is guarded by the same "just added" flag');
});

test('the scheduler picks up leases with only WhatsApp ticked, and tenants with only a phone', () => {
  const src = read('../src/services/scheduler.js');
  for (const k of ['checkin', 'checkout', 'renewal']) {
    assert.match(src, new RegExp(`\\(l\\.tenant_${k} = 1 OR l\\.wa_tenant_${k} = 1\\)`));
  }
  const reach = /\(t\.phone IS NOT NULL AND t\.phone != ''\)/g;
  assert.ok((src.match(reach) || []).length >= 4, 'overdue, check-in, check-out and renewal');
});

test('lease create and edit both save the WhatsApp ticks; create falls back to the email ticks', () => {
  const src = read('../src/routes/leasing.js');
  assert.match(src, /whatsappToggleAssignments\(req\.body, \{ fallbackToEmail: true \}\)/);
  assert.match(src, /const wa = whatsappToggleAssignments\(req\.body\);/);
});

test('Create Lease and Edit Lease both show the same WhatsApp block and send its values', () => {
  for (const rel of ['../../frontend/src/app/leasing/create/page.js', '../../frontend/src/app/leasing/[id]/edit/page.js']) {
    const page = read(rel);
    assert.match(page, /<WhatsAppNotificationsCard form=\{form\}/, rel);
    assert.match(page, /\.\.\.whatsappTogglePayload\(values\)/, rel);
  }
  assert.match(read('../../frontend/src/app/leasing/[id]/edit/page.js'), /\.\.\.whatsappTogglePayload\(d\)/, 'edit loads the saved ticks');
});

test('Create Lease ticks WhatsApp posted, overdue, check-in, check-out and renewal by default', () => {
  const card = read('../../frontend/src/components/WhatsAppNotificationsCard.jsx');
  const block = card.slice(card.indexOf('WHATSAPP_CREATE_DEFAULTS = {'), card.indexOf('};', card.indexOf('WHATSAPP_CREATE_DEFAULTS = {')));
  for (const n of ['wa_tenant_posted', 'wa_tenant_overdue', 'wa_tenant_checkin', 'wa_tenant_checkout', 'wa_tenant_renewal']) {
    assert.match(block, new RegExp(`${n}: true`));
  }
  assert.doesNotMatch(block, /wa_tenant_deposit_posted/);
  assert.match(read('../../frontend/src/app/leasing/create/page.js'), /initialValues=\{\{[\s\S]*?\.\.\.WHATSAPP_CREATE_DEFAULTS,/);
});

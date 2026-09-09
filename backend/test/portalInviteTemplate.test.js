/**
 * The portal sign-up email is editable, and cannot be edited into uselessness.
 *
 * It was hardcoded, while every other tenant-facing email in the system is
 * editable under Settings > Email Templates. It is also the one a tenant sees
 * FIRST: it arrives unprompted, carries a link, and asks them to set a password.
 *
 * The risk that comes with making it editable is specific. The link is single-use
 * and time-limited, so it is substituted at send time rather than typed into the
 * body. Someone editing in a rich-text box can delete that variable without
 * noticing, and the result is a polite email that gives the reader no way in. So
 * the render refuses a template that has lost it and sends the built-in instead.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { htmlToText, TEMPLATE_TYPE } = require('../src/utils/tenantPortalInvite');
const { TEMPLATE_TYPES, TEMPLATE_VARIABLES } = require('../src/services/emailService');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── it appears in the templates section ─────────────────────────────────────

test('the type is offered in the email template dropdown', () => {
  const entry = TEMPLATE_TYPES.find(t => t.value === 'Portal-Invite-Tenant');
  assert.ok(entry, 'the Settings dropdown reads this list');
  assert.strictEqual(entry.label, 'Tenant Portal Invitation (Tenant)');
});

test('the code and the type list agree on the name', () => {
  assert.strictEqual(TEMPLATE_TYPE, 'Portal-Invite-Tenant');
});

test('the variables an author needs are documented in the picker', () => {
  const keys = TEMPLATE_VARIABLES.map(v => v.key);
  for (const key of ['%Portal Signup Link%', '%Link Expiry Minutes%', '%Company Name%', '%Name - Lease%']) {
    assert.ok(keys.includes(key), `${key} must be listed, or nobody knows it exists`);
  }
});

test('the link variable is described as mandatory', () => {
  const entry = TEMPLATE_VARIABLES.find(v => v.key === '%Portal Signup Link%');
  assert.match(entry.description, /useless without it/i,
    'the one variable that must not be deleted should say so');
});

// ── it cannot be edited into uselessness ────────────────────────────────────

test('a template without the link falls back to the built-in email', () => {
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /if \(!html \|\| !html\.includes\(link\)\)[\s\S]{0,200}return null/,
    'the rendered body is checked for the actual link, not for the variable name');
  assert.match(src, /customised \|\| registrationEmail\(\{ brand: orgName, link \}\)/,
    'null means the built-in wording is used');
});

test('an empty subject also falls back', () => {
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /if \(!subject\)[\s\S]{0,160}return null/);
});

test('a missing or broken template never stops the invitation', () => {
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  const at = src.indexOf('async function renderFromTemplate');
  const block = src.slice(at, src.indexOf('async function prepareInvite'));
  assert.match(block, /catch \(err\)[\s\S]{0,200}return null/,
    'a load failure must not throw into the caller');
  assert.match(block, /if \(!template \|\| !template\.template_content\) return null/);
});

test('the body is read from template_content, the column that exists', () => {
  // This table has template_content, subject, created_time and updated_time. It has
  // no `body` and no `created_at`; naming a column that does not exist made every
  // template load throw once already.
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /template\.template_content/);
  assert.doesNotMatch(src, /template\.body/);
});

// ── the plain-text alternative ──────────────────────────────────────────────

test('the text part keeps the link and loses the markup', () => {
  const html = '<p>Dear Chan,</p><p>Set your password:<br>https://x.test/set?token=abc</p>'
    + '<ul><li>View invoices</li><li>Report a repair</li></ul>';
  const text = htmlToText(html);
  assert.match(text, /https:\/\/x\.test\/set\?token=abc/, 'the link must survive');
  assert.doesNotMatch(text, /<[^>]+>/, 'no tags left');
  assert.match(text, /- View invoices/, 'list items stay legible');
});

test('html entities are decoded rather than shown raw', () => {
  assert.strictEqual(htmlToText('<p>Smith &amp; Co &quot;quoted&quot;</p>'), 'Smith & Co "quoted"');
  assert.strictEqual(htmlToText('<p>a&nbsp;b</p>'), 'a b');
});

test('htmlToText tolerates nothing at all', () => {
  for (const input of ['', null, undefined]) {
    assert.strictEqual(htmlToText(input), '');
  }
});

// ── the seed ────────────────────────────────────────────────────────────────

test('the seed is a script, not a per-org migration', () => {
  // A per-org SQL migration cannot know which org owns the database it runs
  // against. Written as migration 082 first, dry-run against production, and it
  // would have created twelve templates for eleven organisations that do not exist.
  assert.ok(!fs.existsSync(path.join(__dirname, '../migrations-org/082_portal_invite_template.sql')),
    'the migration version must not come back');
  const src = stripComments(read('../scripts/seedPortalInviteTemplate.js'));
  assert.match(src, /FROM organizations WHERE status = 1/, 'master is the authority on org ids');
  assert.match(src, /WHERE org_id = \? AND template_type = \?/, 'and each org is checked on its own id');
});

test('the seed writes nothing without --apply and never overwrites', () => {
  const src = stripComments(read('../scripts/seedPortalInviteTemplate.js'));
  assert.match(src, /if \(!apply\)/);
  const guard = src.indexOf('if (!apply)');
  const insert = src.indexOf('INSERT INTO email_template');
  assert.ok(guard > -1 && insert > guard, 'the INSERT must sit after the dry-run branch');
  assert.match(src, /if \(Number\(has\.n\) > 0\)[\s\S]{0,200}continue/,
    "an org that already has one is left alone — COUNT(*) is a string, so '0' is truthy");
});

test('the seeded body carries every variable it references', () => {
  const src = read('../scripts/seedPortalInviteTemplate.js');
  const at = src.indexOf('const BODY = [');
  const body = src.slice(at, src.indexOf("].join('');", at));
  assert.match(body, /%Portal Signup Link%/, 'without this the seeded email is useless');
  assert.match(body, /%Company Name%/);
  assert.match(body, /%Name - Lease%/);
  assert.match(body, /%Link Expiry%/, 'the readable form; see the expiry tests below');
  assert.doesNotMatch(body, /Tane Residence/, 'three orgs share this codebase');
});

// ── the link now lasts a week ───────────────────────────────────────────────

test('the emailed link lasts 7 days', () => {
  const { TOKEN_TTL_DAYS, TOKEN_TTL_MINUTES, TOKEN_TTL_LABEL } =
    require('../src/utils/tenantPortalRegistration');
  assert.strictEqual(TOKEN_TTL_DAYS, 7);
  assert.strictEqual(TOKEN_TTL_MINUTES, 10080, 'derived, not typed twice');
  assert.strictEqual(TOKEN_TTL_LABEL, '7 days');
});

test('the wording says "7 days", never "10080 minutes"', () => {
  // The number is correct and useless to a reader.
  const { registrationEmail } = require('../src/utils/registrationEmail');
  const email = registrationEmail({ brand: 'Example Ltd', link: 'https://x.test/set?token=abc' });
  for (const part of [email.text, email.html]) {
    assert.match(part, /expires in 7 days/);
    assert.doesNotMatch(part, /10080/);
    assert.doesNotMatch(part, /minutes/);
  }
});

test('both expiry variables are offered, and the readable one is preferred', () => {
  const keys = TEMPLATE_VARIABLES.map(v => v.key);
  assert.ok(keys.includes('%Link Expiry%'));
  assert.ok(keys.includes('%Link Expiry Minutes%'),
    'a template written before the change may still use it');
  const numeric = TEMPLATE_VARIABLES.find(v => v.key === '%Link Expiry Minutes%');
  assert.match(numeric.description, /Prefer %Link Expiry%/);
});

test('the render substitutes both, so an older template still reads correctly', () => {
  const src = stripComments(read('../src/utils/tenantPortalInvite.js'));
  assert.match(src, /'%Link Expiry%': TOKEN_TTL_LABEL/);
  assert.match(src, /'%Link Expiry Minutes%': String\(TOKEN_TTL_MINUTES\)/);
});

test('the seeded copy uses the readable variable', () => {
  const src = read('../scripts/seedPortalInviteTemplate.js');
  const at = src.indexOf('const BODY = [');
  const body = src.slice(at, src.indexOf("].join('');", at));
  assert.match(body, /expires in %Link Expiry% and/);
  assert.doesNotMatch(body, /%Link Expiry Minutes% minutes/,
    'that copy would now render as "expires in 10080 minutes"');
});

// ── refreshing what was already seeded ──────────────────────────────────────

test('--refresh updates only rows nobody has edited', () => {
  const src = stripComments(read('../scripts/seedPortalInviteTemplate.js'));
  assert.match(src, /const untouched = LEGACY_BODIES\.includes\(row\.template_content\) \|\| row\.template_content === BODY/);
  assert.match(src, /if \(!untouched\)[\s\S]{0,220}left alone/,
    "a reworded template is the customer's own text");
  assert.match(src, /LEGACY_BODIES/, 'the previous seed is recorded so it can be recognised');
});

test('--refresh writes nothing without --apply', () => {
  const src = stripComments(read('../scripts/seedPortalInviteTemplate.js'));
  const dryAt = src.indexOf('would refresh template');
  const updateAt = src.indexOf('UPDATE email_template SET subject');
  assert.ok(dryAt > -1 && updateAt > dryAt, 'the UPDATE must sit after the dry-run branch');
});

test('the recorded legacy body really differs from the current one', () => {
  // If they were identical, --refresh could never fire and the stale copy would
  // stay in production reading "expires in 10080 minutes".
  const src = read('../scripts/seedPortalInviteTemplate.js');
  const at = src.indexOf('const LEGACY_BODIES = [');
  const block = src.slice(at, src.indexOf('];', at));
  assert.match(block, /%Link Expiry Minutes% minutes/);
  assert.match(block, /BODY\.replace\(/, 'derived from BODY, so the two cannot drift apart');
});

/**
 * The one field staff write that a tenant reads.
 *
 * `service.note` is internal and `service.tenant_note` is visible. They are two columns
 * rather than one column with a "show this" tick, because a box that is private UNLESS
 * someone remembers to tick something fails in the direction of publishing an internal
 * remark about a tenant to that tenant.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const SERVICE = stripComments(read('../src/routes/service.js'));
const EDIT = stripComments(read('../../frontend/src/app/services/[id]/edit/page.js'));
const DETAIL = stripComments(read('../../frontend/src/app/services/[id]/detail/page.js'));
const PORTAL = stripComments(read('../src/routes/tenantPortal.js'));

// ── staff can write it ──────────────────────────────────────────────────────

test('the full update writes tenant_note', () => {
  const start = SERVICE.indexOf("router.put('/update/:id'");
  const end = SERVICE.indexOf("router.patch('/patch/:id'");
  assert.ok(start > -1 && end > start);
  const handler = SERVICE.slice(start, end);
  assert.match(handler, /tenant_note\s*=\s*\?/, 'the UPDATE does not set tenant_note');
  assert.match(handler, /tenant_note,\s*additional_info/, 'tenant_note is not destructured from the body');
});

test('the partial update allows tenant_note', () => {
  const start = SERVICE.indexOf('const allowedFields');
  const list = SERVICE.slice(start, SERVICE.indexOf(']', start));
  assert.match(list, /'tenant_note'/);
});

test('the edit form always sends tenant_note, even when empty', () => {
  // PUT /update/:id writes every column it is given and nulls the rest. A field that is
  // rendered but omitted from the payload silently erases the tenant's message every
  // time anyone saves anything else on the form.
  assert.match(EDIT, /tenant_note:\s*values\.tenant_note\s*\|\|\s*null/);
  assert.match(EDIT, /tenant_note:\s*data\.tenant_note\s*\|\|\s*''/, 'the form does not load the existing value');
  assert.match(EDIT, /name="tenant_note"/);
});

// ── the two boxes must not be confusable ────────────────────────────────────

test('the staff form says out loud that the tenant reads this box', () => {
  const field = EDIT.slice(EDIT.indexOf('name="tenant_note"'), EDIT.indexOf('name="note"'));
  assert.match(field, /Shown to the tenant/i,
    'nothing on the form tells staff this field is visible to the tenant');
});

test('the internal note is labelled internal wherever the visible one appears', () => {
  assert.match(DETAIL, /label="Message to tenant"/);
  assert.match(DETAIL, /label="Note \(internal\)"/,
    'the internal note sits next to a tenant-visible one without saying which is which');
});

// ── the tenant side reads it, and nothing else ──────────────────────────────

test('the portal returns tenant_note and never the internal note', () => {
  const start = PORTAL.indexOf("router.get('/service'");
  const query = PORTAL.slice(start, PORTAL.indexOf('ORDER BY', start));
  assert.match(query, /s\.tenant_note/);
  assert.ok(!/\bs\.note\b/.test(query), 'the portal query selects the internal note');
  // The other columns a tenant must never receive.
  for (const col of ['assignee', 'priority', 'created_by']) {
    assert.ok(!new RegExp(`s\\.${col}\\b`).test(query), `the portal query selects s.${col}`);
  }
});

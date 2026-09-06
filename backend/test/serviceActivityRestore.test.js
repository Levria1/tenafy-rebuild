/**
 * Deleting a timeline entry must be undoable and must leave evidence.
 *
 * Deleting stays permitted: staff tidy up mistakes and duplicates and rely on it. What
 * changed is that it is no longer destructive. It used to be a real DELETE, so a mis-click
 * destroyed the entry with nothing to restore from and no record it had ever existed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const SERVICE = stripComments(read('../src/routes/service.js'));
const PORTAL = stripComments(read('../src/routes/tenantPortal.js'));
const PAGE = stripComments(read('../../frontend/src/app/services/[id]/detail/page.js'));
const MIGRATION = read('../migrations-org/080_service_activity_soft_delete.sql');

const deleteRoute = () => {
  const start = SERVICE.indexOf("router.delete('/activity/:id'");
  assert.ok(start > -1, 'the delete route is gone');
  return SERVICE.slice(start, SERVICE.indexOf('module.exports', start));
};
const restoreRoute = () => {
  const start = SERVICE.indexOf("router.post('/activity/:id/restore'");
  assert.ok(start > -1, 'there is no restore route');
  return SERVICE.slice(start, SERVICE.indexOf("router.post('/activity'", start));
};

// ── nothing is destroyed ────────────────────────────────────────────────────

test('deleting marks the row instead of removing it', () => {
  const code = deleteRoute();
  assert.ok(!/DELETE FROM service_activity/.test(code),
    'the row is still being destroyed, so it cannot be restored');
  assert.match(code, /UPDATE service_activity SET deleted_at = NOW\(\), deleted_by = \?/);
});

test('what was deleted is recorded before it is touched', () => {
  // activity_log keeps the text even if this table is ever purged for real. Reading the
  // row AFTER the update would record nothing useful.
  const code = deleteRoute();
  const readAt = code.indexOf('SELECT * FROM service_activity');
  const writeAt = code.indexOf('UPDATE service_activity SET deleted_at');
  assert.ok(readAt > -1 && readAt < writeAt, 'the row is not captured before deletion');
  assert.match(code, /logActivity\(req, 'DELETE', 'service_activity'/);
  assert.match(code, /note: full\?\.note/, 'the log does not keep what the entry said');
});

test('deleting twice is harmless', () => {
  assert.match(deleteRoute(), /if \(activity\[0\]\.deleted_at\)/);
});

// ── putting it back ─────────────────────────────────────────────────────────

test('a deleted entry can be restored, with its attachments', () => {
  // The files were soft-deleted alongside it. Restoring the entry without them returns a
  // note stripped of the photographs that were the point of it.
  const code = restoreRoute();
  assert.match(code, /UPDATE service_activity SET deleted_at = NULL, deleted_by = NULL/);
  assert.match(code, /UPDATE object_file SET deleted_at = NULL WHERE object_id = \?/);
  assert.match(code, /logActivity\(req, 'RESTORE', 'service_activity'/);
});

test('restore is org-scoped and refuses an unknown entry', () => {
  const code = restoreRoute();
  assert.match(code, /WHERE id = \? AND org_id = \?/);
  assert.match(code, /if \(!activity\) return res\.status\(404\)/);
});

// ── who sees what ───────────────────────────────────────────────────────────

test('a tenant never sees a deleted entry', () => {
  const start = PORTAL.indexOf("router.get('/service'");
  const list = PORTAL.slice(start, PORTAL.indexOf("router.post('/service'", start));
  assert.match(list, /sa\.deleted_at IS NULL/);
});

test('staff DO see deleted entries, marked, so they can restore them', () => {
  // Filtering them out of the timeline would leave no way to put one back from the screen
  // it was deleted on.
  const detail = SERVICE.slice(SERVICE.indexOf('const [activities]'), SERVICE.indexOf('activity.files = actFiles'));
  assert.ok(!/sa\.deleted_at IS NULL/.test(detail), 'staff cannot see deleted entries to restore them');
  assert.match(detail, /LEFT JOIN user du ON sa\.deleted_by = du\.id/);
  assert.match(detail, /AS deleted_by_name/);

  assert.match(PAGE, /const isDeleted = Boolean\(act\.deleted_at\)/);
  assert.match(PAGE, /act\.deleted_by_name/);    // the marker names who removed it
  assert.match(PAGE, /canEdit && isDeleted/);   // the restore button
  assert.match(PAGE, /canEdit && !isFromTenant && !isDeleted/); // no delete twice
});

test('a tenant-written entry still cannot be deleted at all', () => {
  assert.match(deleteRoute(), /activity\[0\]\.source === 'tenant'/);
});

// ── migration ───────────────────────────────────────────────────────────────

test('080 is guarded on the table and on each column', () => {
  const guards = MIGRATION.match(/@has_table = 1/g) || [];
  const statements = MIGRATION.match(/PREPARE st FROM @s;/g) || [];
  assert.equal(guards.length, statements.length);
  for (const col of ['deleted_at', 'deleted_by']) {
    assert.ok(MIGRATION.includes(`COLUMN_NAME = '${col}'`), `${col} is not guarded`);
  }
  // Existing rows must stay live, or every timeline empties the moment this runs.
  assert.match(MIGRATION, /deleted_at DATETIME NULL/);
});

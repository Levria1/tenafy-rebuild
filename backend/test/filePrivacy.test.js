/**
 * ID documents must never be served without a session.
 *
 * /api/file/preview and /api/file/download are mounted BEFORE the authenticate
 * middleware, deliberately, so public listing photos load for anonymous
 * visitors. Their rule was "anonymous may have images, documents need a login",
 * which held while every image in the table was a property photo.
 *
 * Smart Extract now stores HKID and passport scans, and those are images. Mime
 * type can no longer decide this, so files carry an explicit is_private flag
 * that is checked before the type rule. A file id is a timestamp-based
 * Snowflake, not a secret: one that leaks into a browser history, a shared link
 * or a referrer header would otherwise stay publicly fetchable forever.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fileRoute = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'file.js'), 'utf8');
const tenantRoute = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'tenant.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations-org', '078_file_private_flag.sql'), 'utf8');

function anonymousBranch() {
  const fn = fileRoute.match(/async function resolveAccessibleFile[\s\S]*?\n\}/);
  assert.ok(fn, 'resolveAccessibleFile not found');
  const branch = fn[0].match(/\} else \{[\s\S]*?\n  \}/);
  assert.ok(branch, 'anonymous branch not found');
  return { fn: fn[0], branch: branch[0] };
}

test('the private flag is read from the database', () => {
  const { fn } = anonymousBranch();
  assert.match(fn, /SELECT item_name, filename, mime_type, org_id, is_private FROM file/,
    'the flag cannot be enforced if it is never selected');
});

test('an anonymous request is refused a private file whatever its type', () => {
  const { branch } = anonymousBranch();
  assert.match(branch, /if \(Number\(file\.is_private\) === 1\) return \{ error: 403 \};/,
    'a passport scan is an image, so the image rule alone would let it through');
});

test('the private check runs before the image rule, not after', () => {
  // Order is the whole point. The image rule RETURNS for non-images and falls
  // through for images, so a private check placed after it never sees a photo.
  const { branch } = anonymousBranch();
  const priv = branch.indexOf('is_private');
  const type = branch.indexOf('isImageFile');
  assert.ok(priv > -1 && type > -1);
  assert.ok(priv < type, 'the private check must come first');
});

test('public listing photos are still anonymous', () => {
  // The reason these routes sit outside authenticate in the first place. A fix
  // that broke this would take the public site down.
  const { branch } = anonymousBranch();
  assert.match(branch, /isImageFile\(file\.mime_type/,
    'ordinary images must still pass for anonymous callers');
  const { fn } = anonymousBranch();
  assert.ok(!/router\.use\(authenticate\)[\s\S]*resolveAccessibleFile/.test(fileRoute),
    'preview/download must stay ahead of the auth middleware');
});

test('Smart Extract stores ID screenshots as private', () => {
  assert.match(tenantRoute, /INSERT INTO file \(id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, is_private, created_at\)/,
    'the insert must set the flag, not rely on the column default');
  // NOW() carries its own parenthesis, so match the literal clause rather than
  // trying to balance brackets.
  assert.ok(tenantRoute.includes("VALUES (?, ?, ?, ?, ?, ?, 'local', ?, 1, NOW())"),
    'is_private must be bound to 1, in the position the column list gives it');
});

test('the migration is idempotent and backfills what already shipped', () => {
  assert.match(migration, /information_schema\.COLUMNS/,
    'the ALTER runs against every org database and must be guarded');
  assert.match(migration, /ADD COLUMN is_private TINYINT NOT NULL DEFAULT 0/);
  assert.match(migration, /UPDATE file f[\s\S]*JOIN tenant t[\s\S]*SET f\.is_private = 1/,
    'any ID screenshot already attached to a tenant has to be caught too');
  assert.ok(!/DROP |TRUNCATE/i.test(migration));
});

test('the column default is public, so nothing else changes behaviour', () => {
  // Property photos, service attachments and signature images all keep working
  // exactly as before; only rows explicitly marked private are affected.
  assert.match(migration, /DEFAULT 0/);
});

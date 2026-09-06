/**
 * Repair photos: who can see them, and who cannot.
 *
 * A tenant's repair photo is the inside of somebody's home, uploaded because something
 * broke. Two rules carry that: the file is stored private so the anonymous image route
 * refuses it, and the one route that will serve it proves ownership in SQL rather than
 * trusting anything in the URL.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const ROUTES = read('../src/routes/tenantPortal.js');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Isolate the photo route from the rest of the file before asserting on it. Without
// this, a predicate belonging to some other query would satisfy these tests.
function photoRoute() {
  const src = stripComments(ROUTES);
  const start = src.indexOf("router.get('/service/:id/photo/:fileId'");
  assert.ok(start > -1, 'the tenant photo route is gone');
  const end = src.indexOf('module.exports', start);
  return src.slice(start, end);
}

// ── the upload must not be publicly readable ────────────────────────────────

test('a repair photo is stored private', () => {
  // /api/file/preview serves any image to an anonymous caller, because the public
  // listings site depends on it. is_private is checked BEFORE the is-it-an-image rule,
  // so this flag is the only thing keeping repair photos out of that route. Without it
  // every photo is fetchable by anyone who guesses a Snowflake id.
  const src = stripComments(ROUTES);
  const start = src.indexOf('INSERT INTO file');
  assert.ok(start > -1, 'the portal no longer inserts file rows');
  const insert = src.slice(start, src.indexOf(';', start));
  assert.match(insert, /is_private/, 'the repair photo insert no longer sets is_private');
  assert.match(insert, /VALUES\s*\([^)]*'local',\s*\?,\s*1,/, 'is_private is not being set to 1');
});

// ── the route that serves them back ─────────────────────────────────────────

test('the photo route requires a tenant session', () => {
  assert.match(photoRoute(), /^router\.get\([^,]+,\s*authenticateTenant,/);
});

test('the photo route proves ownership in SQL, not from the URL', () => {
  const code = photoRoute();
  // The request must be this tenant's...
  assert.match(code, /s\.reported_by IN \(\$\{idsIn\(req\)\}\)/);
  // ...in this org, on both the request and the file...
  assert.match(code, /s\.org_id = \?/);
  assert.match(code, /f\.org_id = \?/);
  // ...not deleted...
  assert.match(code, /s\.deleted_at IS NULL/);
  // ...and the file must be linked to THAT request rather than merely existing.
  assert.match(code, /objf\.object_id = s\.id/);
  assert.match(code, /objf\.file_id = \?/);
});

test('the photo route serves only files the tenant uploaded', () => {
  // object_file is a shared junction: a service request also accumulates vendor quotes
  // and inspection photos. source = 'tenant' is the only thing separating them, and
  // dropping it would hand tenants staff material through a route that looks fine.
  assert.match(photoRoute(), /objf\.source = 'tenant'/);
});

test('a missing, foreign or staff-owned photo all answer the same way', () => {
  // Anything that distinguishes them confirms that a given id exists on someone else's
  // request. One 404 for all three.
  const code = photoRoute();
  assert.match(code, /if \(!row\) return res\.status\(404\)/);
  assert.ok(!/403/.test(code), 'the photo route distinguishes "not yours" from "not found"');
});

test('the photo route rejects ids that are not Snowflakes', () => {
  assert.match(photoRoute(), /\/\^\\d\+\$\/\.test\(serviceId\)/);
  assert.match(photoRoute(), /\/\^\\d\+\$\/\.test\(fileId\)/);
});

test('the file on disk is located from the database, not the request', () => {
  const code = photoRoute();
  // item_name comes from the row; the URL never reaches the filesystem. The prefix
  // check is belt and braces against a stored name that climbs out of uploads.
  assert.match(code, /path\.join\(UPLOADS_DIR, row\.item_name/);
  assert.match(code, /startsWith\(UPLOADS_DIR \+ path\.sep\)/);
  assert.ok(!/req\.params[\s\S]{0,80}path\.join/.test(code), 'a URL value is reaching path.join');
});

test('the photo response cannot be cached by a shared cache', () => {
  const code = photoRoute();
  assert.match(code, /Cache-Control['"],\s*['"]private/);
  assert.match(code, /X-Content-Type-Options['"],\s*['"]nosniff/);
});

test('the content type comes from the allow-list, not the stored value', () => {
  // mime_type is whatever the uploading client claimed. Echoing it back unchecked is
  // how an "image" gets served as something the browser will execute.
  assert.match(photoRoute(), /PHOTO_MIME\.has\(row\.mime_type\)/);
});

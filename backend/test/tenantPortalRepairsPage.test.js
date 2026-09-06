/**
 * The repairs screen, checked against the endpoint it posts to.
 *
 * Every test here pins a place where the page and the route have to agree on a literal
 * value. Those are the failures that survive review: both sides look correct on their
 * own, and the mismatch only appears when a tenant presses Submit.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = stripComments(read('../../frontend/src/app/tenant-portal/repairs/page.js'));
const ROUTES = stripComments(read('../src/routes/tenantPortal.js'));
const LAYOUT = stripComments(read('../../frontend/src/app/tenant-portal/layout.js'));

// ── the page is reachable ───────────────────────────────────────────────────

test('repairs appears in the portal navigation', () => {
  // The API client has carried getRepairs/createRepair for a while with no page and no
  // nav entry, which is how the feature stayed invisible.
  assert.match(LAYOUT, /key: '\/tenant-portal\/repairs'/);
});

// ── values both sides must agree on ─────────────────────────────────────────

test('the multipart field name matches the one multer listens for', () => {
  // A mismatch here is silent: the request succeeds, the row is written, and the photos
  // are simply absent.
  assert.match(ROUTES, /photos\('photos'\)/);
  assert.match(PAGE, /fd\.append\('photos',/);
});

test('the description floor matches the server', () => {
  const serverRule = ROUTES.match(/description\.length\s*<\s*(\d+)/);
  assert.ok(serverRule, 'the server no longer enforces a minimum description length');
  const pageRule = PAGE.match(/\{\s*min:\s*(\d+),\s*message:\s*'Please describe/);
  assert.ok(pageRule, 'the form no longer enforces a minimum description length');
  assert.equal(Number(pageRule[1]), Number(serverRule[1]),
    `form minimum (${pageRule && pageRule[1]}) differs from the server's (${serverRule[1]})`);
});

test('the description ceiling matches the server', () => {
  const serverRule = ROUTES.match(/description\.length\s*>\s*(\d+)/);
  const pageRule = PAGE.match(/\{\s*max:\s*(\d+),\s*message:\s*'Please keep this under/);
  assert.ok(serverRule && pageRule);
  assert.equal(Number(pageRule[1]), Number(serverRule[1]));
});

test('the date format the form sends is one the server accepts', () => {
  // The server tests submitted dates against a regex. dayjs formats the value on the
  // page. If they drift, the window is silently dropped: dateOrNull returns null and
  // the request still succeeds, so nobody finds out until a tenant is not visited.
  const pattern = ROUTES.match(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}[^/]*\//);
  assert.ok(pattern, 'the server no longer validates preferred dates');
  const serverRegex = new RegExp(pattern[0].slice(1, -1));

  // Scoped to the submit path. The page also formats dates for display, and those use
  // a human format that would wrongly satisfy a looser search.
  const submitBlock = PAGE.slice(PAGE.indexOf('const windows = ['), PAGE.indexOf("for (const f of fileList)"));
  assert.ok(submitBlock.length > 0, 'could not isolate the preferred-date submit block');
  const fmt = submitBlock.match(/range\[0\]\.format\('([^']+)'\)/);
  assert.ok(fmt, 'the form no longer formats the preferred date');
  assert.equal(fmt[1], 'YYYY-MM-DD HH:mm', 'unexpected format; update this test deliberately');

  // A real value in that format, not the format string itself.
  assert.ok(serverRegex.test('2026-09-08 14:30'),
    'the server would reject the value this form sends');
});

test('the photo cap comes from the server rather than a second copy of the number', () => {
  assert.match(ROUTES, /max_photos: MAX_PHOTOS/);
  assert.match(PAGE, /options\?\.max_photos/);
  assert.match(PAGE, /next\.slice\(0, maxPhotos\)/);
});

test('the category list comes from the server', () => {
  // REPAIR_CATEGORIES is fixed server-side because service.category feeds staff filters
  // and reports. A list retyped in the page would drift and quietly produce categories
  // the submit endpoint then rejects.
  assert.match(PAGE, /options\?\.categories/);
  assert.ok(!/'interior: bathroom'/.test(PAGE), 'the page hardcodes the category list');
  assert.match(ROUTES, /REPAIR_CATEGORIES\.includes\(category\)/);
});

// ── the write rule ──────────────────────────────────────────────────────────

test('the form is disabled when the tenant holds no current lease', () => {
  // The server refuses these with a 403 (requireCurrentLease). Showing an enabled button
  // that always fails is the thing can_raise exists to prevent.
  assert.match(ROUTES, /can_raise: units\.length > 0/);
  assert.match(PAGE, /disabled=\{!canRaise\}/);
});

test('a single tenancy is preset instead of offered as a one-item dropdown', () => {
  // The server accepts an absent unit_id only when exactly one unit is allowed, and
  // demands a choice otherwise. The page mirrors both halves.
  assert.match(PAGE, /units\.length === 1/);
  assert.match(PAGE, /units\.length > 1/);
  assert.match(ROUTES, /else if \(allowed\.length === 1\)/);
});

test('photos are sent with the form, not uploaded ahead of it', () => {
  // beforeUpload returning false keeps the files in the browser until submit, so there
  // is never a stored file with no request attached to it.
  assert.match(PAGE, /beforeUpload=\{\(\) => false\}/);
});

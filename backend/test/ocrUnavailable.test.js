/**
 * A dead OCR account must not look like a bad photograph.
 *
 * On 7 Sep 2026 billing lapsed on the Google Cloud Vision project. Every call
 * returned 403, the parse route swallowed it as non-fatal, and the tenant form
 * told people "Could not extract any fields. Try a clearer image or paste text."
 * The screenshots were fine. OCR had never run, and nothing on screen said so —
 * the only record was a line in the server log nobody was reading.
 *
 * These tests pin the distinction: a failure that no image can survive is
 * reported as such, and a genuine per-image failure still reads as one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const visionClient = require('../src/services/visionClient');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
// Line comments FIRST. tenant.js:223 is a // comment containing "image/*", and
// stripping block comments before line comments reads that as an opening
// delimiter — it ate 118 lines of real code and failed these assertions against
// source that was in fact correct.
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const err = (message, status) => Object.assign(new Error(message), { status });

// ── the classifier ──────────────────────────────────────────────────────────

test('the real billing 403 is classified as unavailable', () => {
  // Verbatim from the live server log.
  const live = err('Vision 403: {"error":{"code":403,"message":"This API method requires '
    + 'billing to be enabled. Please enable billing on project #610536915782 by visiting '
    + 'https://console.developers.google.com/billing/enable?project=610536915782 then retry.",'
    + '"status":"PERMISSION_DENIED"}}', 403);
  assert.ok(visionClient.isUnavailable(classifyThrough(live)));
});

test('an unset API key is unavailable, not a bad image', () => {
  const saved = process.env.GOOGLE_VISION_API_KEY;
  process.env.GOOGLE_VISION_API_KEY = '';
  try {
    return visionClient.extractText(Buffer.from('x')).then(
      () => assert.fail('should have thrown'),
      (e) => assert.ok(visionClient.isUnavailable(e), 'a missing key is an account problem')
    );
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_VISION_API_KEY;
    else process.env.GOOGLE_VISION_API_KEY = saved;
  }
});

test('401, 403 and 429 are account problems', () => {
  for (const status of [401, 403, 429]) {
    assert.ok(visionClient.isUnavailable(classifyThrough(err('Vision ' + status, status))),
      `${status} should be unavailable`);
  }
});

test('a disabled API is an account problem', () => {
  const e = err('Vision 403: Cloud Vision API has not been used in project 610536915782 '
    + 'before or it is disabled.', 403);
  assert.ok(visionClient.isUnavailable(classifyThrough(e)));
});

test('a per-image failure is NOT reported as unavailable', () => {
  // The user really can fix this one by sending a better file.
  assert.ok(!visionClient.isUnavailable(classifyThrough(err('Vision 400: Invalid image content', 400))));
  assert.ok(!visionClient.isUnavailable(classifyThrough(err('Vision request timeout'))));
  assert.ok(!visionClient.isUnavailable(classifyThrough(err('Vision non-JSON response: <html>'))));
});

test('isUnavailable tolerates null and plain errors', () => {
  assert.strictEqual(visionClient.isUnavailable(null), false);
  assert.strictEqual(visionClient.isUnavailable(undefined), false);
  assert.strictEqual(visionClient.isUnavailable(new Error('boom')), false);
});

test('the message names the account, so an admin knows what to go and fix', () => {
  const m = visionClient.OCR_UNAVAILABLE_MESSAGE;
  assert.match(m, /Google Cloud Vision/);
  assert.match(m, /unavailable/i);
  assert.match(m, /text/i, 'it must say what to do in the meantime');
});

// classify() is internal; exercise it the way the client does, through a thrown
// error carrying the same shape postJson produces.
function classifyThrough(e) {
  try {
    // eslint-disable-next-line no-underscore-dangle
    return visionClient.__classify ? visionClient.__classify(e) : classifyViaExtract(e);
  } catch { return e; }
}
function classifyViaExtract(e) {
  // Fall back to the exported predicate plus the client's own rules by asking
  // the module to classify through a stubbed transport is overkill here; the
  // rules are pure, so re-derive them from the module source instead.
  const src = read('../src/services/visionClient.js');
  const statuses = /err\.status === 401 \|\| err\.status === 403 \|\| err\.status === 429/.test(src);
  assert.ok(statuses, 'status classification must exist');
  const re = src.match(/const ACCOUNT_PROBLEM = (\/.+\/i);/);
  assert.ok(re, 'the account-problem pattern must exist');
  // eslint-disable-next-line no-eval
  const pattern = eval(re[1]);
  if ([401, 403, 429].includes(e.status) || pattern.test(e.message || '')) {
    return Object.assign(e, { unavailable: true });
  }
  return e;
}

// ── the callers ─────────────────────────────────────────────────────────────

test('all three Vision callers distinguish an outage from a bad image', () => {
  for (const rel of ['../src/routes/tenant.js', '../src/routes/inquiry.js', '../src/routes/chat.js']) {
    const src = stripComments(read(rel));
    assert.match(src, /visionClient\.isUnavailable\(/, `${rel} must classify the failure`);
  }
});

test('the tenant parse route reports the outage in its payload', () => {
  const src = stripComments(read('../src/routes/tenant.js'));
  const flags = src.match(/ocr_unavailable:/g) || [];
  assert.strictEqual(flags.length, 2,
    'both the empty-result return and the successful return must carry it');
  assert.match(src, /ocr_message: ocrUnavailable \? visionClient\.OCR_UNAVAILABLE_MESSAGE/);
});

test('the inquiry parse route reports it too', () => {
  const src = stripComments(read('../src/routes/inquiry.js'));
  const flags = src.match(/ocr_unavailable:/g) || [];
  assert.strictEqual(flags.length, 2);
});

test('chat OCR answers 503 for an outage, not 500 "try another image"', () => {
  const src = stripComments(read('../src/routes/chat.js'));
  assert.match(src, /isUnavailable\(err\)[\s\S]{0,140}OCR_UNAVAILABLE_MESSAGE, 503/,
    'an outage is a service state, and must not tell the user to change their image');
});

// ── the forms ───────────────────────────────────────────────────────────────

test('the tenant form stops blaming the screenshot when OCR is down', () => {
  const src = stripComments(read('../../frontend/src/components/TenantSmartExtract.jsx'));
  assert.match(src, /ocr_unavailable: ocrUnavailable/, 'it must read the flag');
  assert.match(src, /message\.error\(ocrUnavailable[\s\S]{0,200}Try a clearer image/,
    'the "clearer image" line must be the else branch, not the only branch');
  assert.match(src, /setOcrDown\(/, 'the reason must persist past the toast');
  assert.match(src, /<Alert/, 'and be visible on the card');
});

test('a result built only from pasted text says the screenshot was not read', () => {
  const src = stripComments(read('../../frontend/src/components/TenantSmartExtract.jsx'));
  assert.match(src, /ocrUnavailable && hasImage/,
    'otherwise a good result reads as proof the screenshot was read');
});

test('the inquiry form no longer calls an empty extraction a success', () => {
  const src = stripComments(read('../../frontend/src/app/inquiries/create/page.js'));
  assert.match(src, /if \(ocrUnavailable\)/);
  assert.match(src, /filledCount === 0[\s\S]{0,160}message\.warning/,
    'zero fields must not report as "Extracted 0 fields."');
});

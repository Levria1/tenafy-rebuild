/**
 * Smart Extract keeps the ID screenshot and attaches it to the tenant.
 *
 * It used to OCR the image in memory and throw it away, on the reasoning that
 * HKID and passport photos are PII best not held. That was reversed
 * deliberately. The practical cost of the old behaviour showed up immediately:
 * when a passport number came out wrong, the image was gone and the misread
 * could not be reproduced from the thing the machine had actually seen.
 *
 * These are source-inspection tests. The endpoint needs multer, Vision, an LLM
 * and a MySQL pool, and the realistic regression is a later edit dropping a
 * link or a scoping clause, not someone rewriting the route.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'tenant.js'), 'utf8');

test('the screenshot is written to disk, not held in memory', () => {
  const upload = route.match(/const parseUpload = multer\(\{[\s\S]*?\n\}\);/);
  assert.ok(upload, 'parseUpload not found');
  assert.match(upload[0], /diskStorage/,
    'memoryStorage would discard the image the moment the request ends');
  assert.ok(!/memoryStorage/.test(upload[0]));
  assert.match(upload[0], /startsWith\('image\/'\)/,
    'the image-only filter must survive the change of storage');
  assert.match(upload[0], /fileSize: 10 \* 1024 \* 1024/, 'and so must the size cap');
});

test('a file row is recorded and its id returned to the caller', () => {
  assert.match(route, /INSERT INTO file \(id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, created_at\)/,
    'the screenshot must be registered like every other attachment');
  assert.match(route, /file_id: savedFileId/,
    'the create form cannot link a file whose id it never receives');
});

test('a failure to record the screenshot does not lose the extraction', () => {
  // The extraction is the thing the user asked for. Losing the file row is
  // annoying; losing the parsed fields would send them back to typing by hand.
  const block = route.match(/savedFileId = \(BigInt[\s\S]*?catch \(fileErr\) \{[\s\S]*?\}/);
  assert.ok(block, 'the file insert is not wrapped in its own catch');
  assert.match(block[0], /savedFileId = null/,
    'a failed insert must clear the id rather than return a row that does not exist');
});

test('files are linked on create and on update', () => {
  const create = route.match(/router\.post\('\/', authenticate[\s\S]*?\n\}\);/);
  assert.ok(create, 'create handler not found');
  assert.match(create[0], /linkFilesToTenant\(req\.pool, orgId, tenantId, file_ids\)/,
    'the create form defers linking until the tenant id exists');

  const update = route.match(/router\.put\('\/:id\/profile'[\s\S]*?\n\}\);/);
  assert.ok(update, 'update handler not found');
  assert.match(update[0], /linkFilesToTenant\(req\.pool, req\.user\.orgId, id, file_ids\)/);
});

test('a failed link never fails a save that already happened', () => {
  // The tenant row is written first. Throwing afterwards would show the user an
  // error for a save that succeeded, and the natural response is to submit
  // again, which creates a duplicate contact.
  for (const handler of ['create', 'update']) {
    const re = handler === 'create'
      ? /router\.post\('\/', authenticate[\s\S]*?\n\}\);/
      : /router\.put\('\/:id\/profile'[\s\S]*?\n\}\);/;
    const body = route.match(re)[0];
    const link = body.indexOf('linkFilesToTenant');
    const guard = body.lastIndexOf('try {', link);
    assert.ok(guard > -1 && body.slice(guard, link).length < 400,
      `${handler}: the link call must sit in its own try`);
  }
});

test('a caller cannot staple another org\'s file onto their tenant', () => {
  const linker = route.match(/async function linkFilesToTenant[\s\S]*?\n\}/);
  assert.ok(linker, 'linkFilesToTenant not found');
  assert.ok(/FROM file[\s\S]{0,40}WHERE org_id = \?/.test(linker[0]),
    'file ids arrive from the client and must be re-checked against the org');
  assert.ok(linker[0].includes('/^\\d+$/'),
    'ids are interpolated into an IN list, so they must be digits only');
});

test('listing a tenant\'s documents is scoped by the tenant AND the org', () => {
  const list = route.match(/router\.get\('\/:id\/files'[\s\S]*?\n\}\);/);
  assert.ok(list, 'GET /:id/files not found');
  assert.match(list[0], /FROM tenant WHERE id = \? AND org_id = \?/,
    'without the tenant ownership check, any id in the URL lists that tenant');
  assert.match(list[0], /f\.org_id = \?/, 'and the files themselves must be org-scoped');
  assert.match(list[0], /of2\.deleted_at IS NULL/);
});

test('removing a document unlinks it rather than destroying the file', () => {
  const del = route.match(/router\.delete\('\/:id\/files\/:fileId'[\s\S]*?\n\}\);/);
  assert.ok(del, 'DELETE /:id/files/:fileId not found');
  assert.match(del[0], /UPDATE object_file[\s\S]*?SET of2\.deleted_at = NOW\(\)/,
    'the same image may be attached elsewhere; deleting the file would break those');
  assert.ok(!/DELETE FROM file/.test(del[0]));
  assert.match(del[0], /f\.org_id = \?/, 'org scoping on the unlink too');
});

test('the MRZ result outranks the LLM for the fields it verified', () => {
  const parse = route.match(/const mrz = parseMrz\(combined\);[\s\S]*?\n    \}/);
  assert.ok(parse, 'MRZ merge block not found');
  assert.match(parse[0], /if \(mrz\.document_number\) fields\.id_card = mrz\.document_number/,
    'the verified passport number must win over the LLM guess');
  // Names are the exception: the MRZ strips them to A-Z, losing accents and any
  // Chinese, so the printed-name read is better.
  assert.match(parse[0], /if \(!fields\.last_name && mrz\.last_name\)/,
    'MRZ names are the fallback, not the winner');
});

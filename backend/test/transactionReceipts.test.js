/**
 * A receipt attached to a payment must be findable afterwards.
 *
 * The Create Payment form has always had an upload box, and it worked in the
 * shallowest sense: the file reached the server and a `file` row was written. But
 * the form discarded the id it got back, `accounting` had no column for it, and
 * the transaction drawer rendered the hard-coded words "No files attached" behind
 * a comment reading "Files section placeholder". Three separate gaps, so a
 * receipt for a Stripe settlement was stored and then linked to nothing.
 *
 * 549 uploads on the live database sit within five minutes of a payment being
 * created and are attached to nothing at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  linkTransactionFiles, unlinkTransactionFiles, listTransactionFiles,
} = require('../src/utils/transactionFiles');

// Line comments FIRST — a "/*" inside one otherwise opens a phantom block comment.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const ORG = '8300127259922432';
const TXN = '1788254859428403026';

// A pool that records what it was asked, and answers from a tiny fixture.
function fakePool({ ownedFileIds = [], existingLinks = [], rows = null } = {}) {
  const calls = [];
  const pool = {
    calls,
    execute: async (sql, params = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM file\s+WHERE id IN/i.test(sql)) {
        const ids = params.slice(0, params.length - 1).map(String);
        const org = String(params[params.length - 1]);
        if (org !== ORG) return [[]];
        return [ids.filter(i => ownedFileIds.includes(i)).map(id => ({ id }))];
      }
      // "is this file attached to anything ELSE" — file_id first, object_id second.
      if (/WHERE file_id = \? AND object_id <> \?/i.test(sql)) {
        const [fileId, objectId] = params.map(String);
        const n = existingLinks.some(l => l[1] === fileId && l[0] !== objectId) ? '1' : '0';
        return [[{ n }]];
      }
      if (/COUNT\(\*\) AS n FROM object_file/i.test(sql)) {
        const [objectId, fileId] = params.map(String);
        const n = existingLinks.some(l => l[0] === objectId && l[1] === fileId) ? '1' : '0';
        return [[{ n }]];
      }
      if (/^SELECT CAST\(f\.id AS CHAR\)/i.test(sql.trim()) || /FROM object_file objf/i.test(sql)) {
        return [rows || []];
      }
      if (/^UPDATE object_file/i.test(sql.trim())) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    },
  };
  return pool;
}
const inserts = (pool) => pool.calls.filter(c => /^INSERT INTO object_file/i.test(c.sql));
const privacyWrites = (pool) => pool.calls.filter(c => /UPDATE file SET is_private = 1/i.test(c.sql));

// ── linking ─────────────────────────────────────────────────────────────────

test('a receipt this org owns is linked to the transaction', async () => {
  const pool = fakePool({ ownedFileIds: ['1788254852155585152'] });
  const linked = await linkTransactionFiles(pool, ORG, TXN, ['1788254852155585152']);
  assert.deepStrictEqual(linked, ['1788254852155585152']);
  assert.strictEqual(inserts(pool).length, 1);
  assert.deepStrictEqual(inserts(pool)[0].params, [TXN, '1788254852155585152']);
});

test("another org's file is refused", async () => {
  // A file id is a timestamp-based Snowflake, not a secret. Accepting one
  // unchecked would let a caller attach someone else's file to their own
  // transaction and then read it back through the preview route.
  const pool = fakePool({ ownedFileIds: [] });
  const linked = await linkTransactionFiles(pool, ORG, TXN, ['999999999999999']);
  assert.deepStrictEqual(linked, []);
  assert.strictEqual(inserts(pool).length, 0);
});

test('an attached receipt is marked private', async () => {
  // /api/file/preview serves NON-private files to anonymous callers on purpose so
  // listing photos load without a login. A receipt can show a card tail or a bank
  // reference, so it must not sit on the public side of that rule.
  const pool = fakePool({ ownedFileIds: ['5'] });
  await linkTransactionFiles(pool, ORG, TXN, ['5']);
  assert.strictEqual(privacyWrites(pool).length, 1);
  assert.deepStrictEqual(privacyWrites(pool)[0].params, ['5', ORG]);
});

test('re-submitting the same receipt does not stack duplicate links', async () => {
  const pool = fakePool({ ownedFileIds: ['5'], existingLinks: [[TXN, '5']] });
  await linkTransactionFiles(pool, ORG, TXN, ['5']);
  assert.strictEqual(inserts(pool).length, 0, 'the link already exists');
});

test("a duplicate check reading COUNT '0' still links", async () => {
  // COUNT(*) arrives as a STRING because the pools set bigNumberStrings, and '0'
  // is truthy. Comparing it as a truthy value would refuse every first link.
  const pool = fakePool({ ownedFileIds: ['5'], existingLinks: [] });
  await linkTransactionFiles(pool, ORG, TXN, ['5']);
  assert.strictEqual(inserts(pool).length, 1);
});

test('rubbish ids are dropped before they reach a query', async () => {
  const pool = fakePool({ ownedFileIds: ['5'] });
  const linked = await linkTransactionFiles(pool, ORG, TXN, ['abc', '', null, undefined, '1; DROP TABLE file', -3, {}]);
  assert.deepStrictEqual(linked, []);
  assert.strictEqual(pool.calls.length, 0, 'nothing should have been queried at all');
});

test('the same id twice in one payload links once', async () => {
  const pool = fakePool({ ownedFileIds: ['5'] });
  await linkTransactionFiles(pool, ORG, TXN, ['5', '5', ' 5 ']);
  assert.strictEqual(inserts(pool).length, 1);
});

test('no file ids means no work', async () => {
  for (const input of [undefined, null, [], 'not-an-array', 42]) {
    const pool = fakePool({ ownedFileIds: ['5'] });
    assert.deepStrictEqual(await linkTransactionFiles(pool, ORG, TXN, input), []);
    assert.strictEqual(pool.calls.length, 0);
  }
});

// ── detaching ───────────────────────────────────────────────────────────────

test('detaching soft-deletes the link and keeps the file', async () => {
  const pool = fakePool();
  await unlinkTransactionFiles(pool, TXN, '5');
  const upd = pool.calls.find(c => /^UPDATE object_file SET deleted_at/i.test(c.sql));
  assert.ok(upd, 'the link is soft-deleted');
  assert.deepStrictEqual(upd.params, [TXN, '5']);
  assert.ok(!pool.calls.some(c => /DELETE FROM file|DELETE FROM object_file/i.test(c.sql)),
    'the file row and the bytes must survive so a mistake is recoverable');
});

// ── listing ─────────────────────────────────────────────────────────────────

test('an image is flagged for inline preview, a PDF is not', async () => {
  const pool = fakePool({ rows: [
    { id: '1', filename: 'receipt.png', item_name: 'a.png', mime_type: 'IMAGE/PNG', file_size: '2048', attached_at: '2026-09-01 09:27:00' },
    { id: '2', filename: 'statement.pdf', item_name: 'b.pdf', mime_type: 'APPLICATION/PDF', file_size: '4096', attached_at: '2026-09-01 09:28:00' },
  ] });
  const files = await listTransactionFiles(pool, ORG, TXN);
  assert.strictEqual(files[0].is_image, true, 'mime_type is stored UPPERCASE');
  assert.strictEqual(files[1].is_image, false);
  assert.strictEqual(files[0].preview_url, '/api/file/preview/1');
  assert.strictEqual(files[1].download_url, '/api/file/download/2');
  assert.strictEqual(files[0].file_size, 2048, 'sizes arrive as strings and must be numbers');
});

test('the listing is scoped by org as well as by transaction', async () => {
  const pool = fakePool({ rows: [] });
  await listTransactionFiles(pool, ORG, TXN);
  const q = pool.calls[0];
  assert.match(q.sql, /objf\.object_id = \? AND objf\.deleted_at IS NULL AND f\.org_id = \?/);
  assert.deepStrictEqual(q.params, [TXN, ORG]);
});

test('the query does not alias object_file as the reserved word OF', () => {
  // `FROM object_file of` is a syntax error in MySQL 8 that only appears at
  // runtime. It already cost a broken repair-photo reload once.
  // Comments stripped and the keyword required in UPPERCASE. Case-insensitively
  // against the raw file, this matched the comment that explains the hazard.
  const src = stripComments(read('../src/utils/transactionFiles.js'));
  assert.doesNotMatch(src, /\b(FROM|JOIN)\s+object_file\s+of\b/);
  assert.match(src, /FROM object_file objf/);
});

// ── the routes ──────────────────────────────────────────────────────────────

test('create and update both accept file_ids', () => {
  const src = stripComments(read('../src/routes/accounting.js'));
  assert.strictEqual((src.match(/linkTransactionFiles\(req\.pool, orgId/g) || []).length, 2,
    'the create and the update path');
  assert.match(src, /lines, file_ids\s*\n?\s*\} = req\.body/);
});

test('an editing save ADDS receipts rather than replacing the set', () => {
  // The edit form does not know what is already attached, so treating its payload
  // as the complete set would detach every existing receipt on an amount change.
  const src = stripComments(read('../src/routes/accounting.js'));
  assert.doesNotMatch(src, /unlinkTransactionFiles\(req\.pool, id\)\s*;/,
    'the update path must not clear existing links');
});

test('attaching a receipt never costs the payment record', () => {
  const src = stripComments(read('../src/routes/accounting.js'));
  const guarded = src.match(/try \{\s*await linkTransactionFiles\([\s\S]{0,200}?catch \(fileErr\)/g) || [];
  assert.strictEqual(guarded.length, 2,
    'losing the link to a receipt is bad; losing the payment would be worse');
});

test('the files route proves the transaction belongs to the org first', () => {
  const src = stripComments(read('../src/routes/accounting.js'));
  assert.match(src, /router\.get\('\/account\/:id\/files'[\s\S]{0,400}FROM accounting WHERE id = \? AND org_id = \? AND deleted_at IS NULL/);
});

test('detaching requires edit permission and proves ownership of both sides', () => {
  const src = stripComments(read('../src/routes/accounting.js'));
  const at = src.indexOf("router.delete('/account/:id/file/:fileId'");
  assert.ok(at > -1, 'the detach route must exist');
  const block = src.slice(at, at + 1400);
  assert.match(block, /requirePermission\('LANDLORD\/ACCOUNTING_EDIT'\)/);
  assert.match(block, /FROM accounting WHERE id = \? AND org_id = \?/);
  assert.match(block, /FROM file WHERE id = \? AND org_id = \?/,
    "a guessed file id must not detach another org's attachment");
  assert.match(block, /logActivity\(req, 'DELETE', 'accounting_file'/);
});

// ── the forms and the drawer ─────────────────────────────────────────────────

test('the payment form captures the uploaded id instead of discarding it', () => {
  const src = stripComments(read('../../frontend/src/app/accounting/invoices/payment/create/page.js'));
  assert.doesNotMatch(src, /action="\/api\/file\/upload"/,
    '`action` posts the file and throws the response away');
  assert.match(src, /customRequest=\{async \(\{ file, onSuccess, onError \}\)/);
  assert.match(src, /setReceipts\(prev => \[\.\.\.prev, \{ id: String\(id\), name: file\.name \}\]\)/);
  assert.match(src, /file_ids: receipts\.map\(r => r\.id\)/, 'and sends them with the payment');
});

test('the edit form does the same', () => {
  const src = stripComments(read('../../frontend/src/app/accounting/accounts/[id]/edit/page.js'));
  assert.doesNotMatch(src, /action="\/api\/file\/upload"/);
  assert.match(src, /file_ids: receipts\.map\(r => r\.id\)/);
});

test('the drawer renders real attachments, not a hard-coded string', () => {
  const src = stripComments(read('../../frontend/src/app/accounting/page.js'));
  assert.match(src, /drawerFiles\.length === 0/, 'the empty state must be conditional');
  assert.match(src, /drawerFiles\.map\(f =>/);
  assert.match(src, /f\.is_image \?/, 'images preview inline');
  assert.match(src, /loadDrawerFiles\(record\.id\)/, 'loaded when the drawer opens');
  assert.match(src, /API_BASE/, 'relative paths need the api origin, not the Next origin');
});

test('a failed file load does not take the transaction detail with it', () => {
  const src = read('../../frontend/src/app/accounting/page.js');
  const at = src.indexOf('const loadDrawerFiles');
  const block = src.slice(at, at + 700);
  assert.match(block, /catch \(error\)/);
  assert.doesNotMatch(block, /message\.error/, 'the detail is still worth showing');
});


// ── findings from the review of e20c4fa ─────────────────────────────────────

test('a file already attached elsewhere is NOT privatised', async () => {
  // is_private lives on the file row, so flipping it affects every place that
  // file appears. A picture already attached to something else may be a listing
  // photo that logged-out visitors load, and privatising it would 403 them.
  const pool = fakePool({ ownedFileIds: ['5'], existingLinks: [['9999', '5']] });
  await linkTransactionFiles(pool, ORG, TXN, ['5']);
  assert.strictEqual(inserts(pool).length, 1, 'it is still attached to the payment');
  assert.strictEqual(privacyWrites(pool).length, 0, 'but its privacy is left alone');
});

test('the shared check runs BEFORE the insert', async () => {
  // Checked afterwards, the row just written would count as another attachment
  // and no receipt would ever be privatised.
  const pool = fakePool({ ownedFileIds: ['5'] });
  await linkTransactionFiles(pool, ORG, TXN, ['5']);
  const probeAt = pool.calls.findIndex(c => /file_id = \? AND object_id <> \?/i.test(c.sql));
  const insertAt = pool.calls.findIndex(c => /^INSERT INTO object_file/i.test(c.sql));
  assert.ok(probeAt > -1 && insertAt > probeAt);
  assert.strictEqual(privacyWrites(pool).length, 1, 'a receipt attached nowhere else is privatised');
});

test('a Snowflake sent as a rounded JSON number is dropped, not guessed at', async () => {
  // Date.now() * 1e6 exceeds Number.MAX_SAFE_INTEGER, so a client sending an id
  // as a number has already had it rounded by the parser. The rounded value is a
  // plausible id belonging to some other row.
  const rounded = 1788254852155585152; // as a NUMBER, already lossy
  assert.ok(!Number.isSafeInteger(rounded), 'precondition: this cannot survive as a number');
  const pool = fakePool({ ownedFileIds: [String(rounded)] });
  const linked = await linkTransactionFiles(pool, ORG, TXN, [rounded]);
  assert.deepStrictEqual(linked, []);
  assert.strictEqual(pool.calls.length, 0, 'it must not reach a query at all');
});

test('a small id sent as a number is still accepted', async () => {
  // Only unsafe integers are suspect. Rejecting every number would be overreach.
  const pool = fakePool({ ownedFileIds: ['5'] });
  assert.deepStrictEqual(await linkTransactionFiles(pool, ORG, TXN, [5]), ['5']);
});

test('duplicate links cannot show the same receipt twice', async () => {
  // linkTransactionFiles' check-then-insert is not atomic, so two concurrent
  // submits of the same payment can both insert. The listing groups by file so
  // the duplicate is invisible.
  const pool = fakePool({ rows: [] });
  await listTransactionFiles(pool, ORG, TXN);
  assert.match(pool.calls[0].sql, /GROUP BY f\.id/);
  assert.match(pool.calls[0].sql, /MIN\(objf\.created_at\)/,
    'with a deterministic attached_at once the rows are collapsed');
});

test('detaching clears every matching link, not just one', async () => {
  const pool = fakePool();
  await unlinkTransactionFiles(pool, TXN, '5');
  const upd = pool.calls.find(c => /^UPDATE object_file SET deleted_at/i.test(c.sql));
  assert.doesNotMatch(upd.sql, /LIMIT/, 'a duplicated link must not survive a detach');
});

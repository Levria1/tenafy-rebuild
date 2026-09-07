/**
 * A receipt must not print the same sentence twice.
 *
 * Xero staging joined the transaction Reference and its line-item Descriptions with
 * ' — '. Tane's Xero data holds the same sentence in both, so 567 accounting notes
 * were stored twice over. Only single-invoice receipts showed it: a receipt covering
 * several invoices reads each line's own invoice note and never touches the payment
 * note, which is why the earlier per-line fix looked complete.
 *
 * The strings below are real values from the live database. The genuine ones matter
 * as much as the duplicated ones — the rule has to leave them alone.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { collapseDuplicateNote, NOTE_JOIN } = require('../src/utils/paymentNote');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── what must collapse ──────────────────────────────────────────────────────

test('the reported receipt collapses to one sentence', () => {
  const sentence = 'TRIV34982 Rental payment for Sept. 1 - 30, 2026';
  assert.strictEqual(collapseDuplicateNote(sentence + NOTE_JOIN + sentence), sentence);
});

test('halves differing only by a stray newline still collapse', () => {
  // Four live rows look like this. A reader sees the same text twice either way.
  assert.strictEqual(
    collapseDuplicateNote('APC COLL-WATER BILLS for NPH — APC COLL-WATER BILLS for NPH\n'),
    'APC COLL-WATER BILLS for NPH'
  );
  assert.strictEqual(
    collapseDuplicateNote('TRIV34930 Deposit refund for Poplar 1B — \nTRIV34930 Deposit refund for Poplar 1B'),
    'TRIV34930 Deposit refund for Poplar 1B'
  );
});

test('the collapsed value carries no leading or trailing whitespace', () => {
  assert.strictEqual(collapseDuplicateNote(' Rent  —  Rent '), 'Rent');
});

// ── what must survive untouched ─────────────────────────────────────────────

test('a genuine reference and description pair is left alone', () => {
  const note = 'ch_3Tfu7tAmLMLva0Qs0df2mA2i | pi_3Tfu7tAmLMLva0Qs0MDLydnx — Stripe Fee';
  assert.strictEqual(collapseDuplicateNote(note), note);
});

test('a batch payment keeps its full line-item list', () => {
  const note = 'Tane Monthly Payments - $306,308 — CL Salary | Office Rent | Chris Salary';
  assert.strictEqual(collapseDuplicateNote(note), note);
});

test('halves differing only by case are NOT collapsed', () => {
  // Deliberate. Stripe charge and payment-intent ids are case-sensitive, so two ids
  // differing only in case are two different objects. One live row ("mercer" vs
  // "Mercer") stays duplicated rather than buy it with a rule that could merge those.
  const note = 'Payment for mercer public electricity $1,679.75 — Payment for Mercer public electricity $1,679.75';
  assert.strictEqual(collapseDuplicateNote(note), note);
});

test('a note with more than one separator is left alone', () => {
  const note = 'A — B — A';
  assert.strictEqual(collapseDuplicateNote(note), note);
});

test('a note that repeats without the separator is left alone', () => {
  const note = 'Rent Rent';
  assert.strictEqual(collapseDuplicateNote(note), note);
});

test('empty halves do not collapse the note to nothing', () => {
  // ' — ' must not become '', which would erase the description entirely.
  assert.strictEqual(collapseDuplicateNote(NOTE_JOIN), NOTE_JOIN);
  assert.strictEqual(collapseDuplicateNote(' — '), ' — ');
});

test('non-string input passes straight through', () => {
  assert.strictEqual(collapseDuplicateNote(null), null);
  assert.strictEqual(collapseDuplicateNote(undefined), undefined);
  assert.strictEqual(collapseDuplicateNote(''), '');
});

test('collapsing is idempotent', () => {
  const sentence = 'TRIV34982 Rental payment for Sept. 1 - 30, 2026';
  const once = collapseDuplicateNote(sentence + NOTE_JOIN + sentence);
  assert.strictEqual(collapseDuplicateNote(once), once);
});

// ── the call sites ──────────────────────────────────────────────────────────

test('xeroSync collapses the note it builds instead of joining blindly', () => {
  const src = stripComments(read('../src/services/xeroSync.js'));
  assert.match(src, /collapseDuplicateNote\(\s*\n?\s*\[reference, lineDescriptions\]/,
    'the Reference/description join must pass through collapseDuplicateNote');
  assert.doesNotMatch(src, /const description = \[reference, lineDescriptions\]\.filter\(Boolean\)\.join/,
    'the raw join must be gone, or Xero will keep storing duplicated notes');
});

test('both receipt builders collapse the payment note before printing it', () => {
  const src = stripComments(read('../src/routes/pdf.js'));
  const guarded = src.match(/collapseDuplicateNote\(pmt\.payment_note\)/g) || [];
  assert.strictEqual(guarded.length, 2,
    'the /receipt route and the email buffer copy must both collapse it');
  const raw = src.match(/\(pmt\.payment_note \|\|/g) || [];
  assert.strictEqual(raw.length, 0, 'no receipt path may print pmt.payment_note unguarded');
});

test('the backfill uses the same rule the receipt uses', () => {
  // If the script had its own SQL predicate it could drift from the renderer, and
  // MySQL TRIM() does not strip the newlines that four of the live rows carry.
  const src = stripComments(read('../scripts/backfillDuplicatePaymentNotes.js'));
  assert.match(src, /require\('\.\.\/src\/utils\/paymentNote'\)/);
  assert.match(src, /collapseDuplicateNote\(row\.note\)/);
  assert.match(src, /accounting_note_backfill_backup/, 'changes must be snapshotted before writing');
  assert.match(src, /INSERT IGNORE INTO accounting_note_backfill_backup/,
    'a re-run must not overwrite the original snapshot');
});

test('the backfill writes nothing without --apply', () => {
  const src = stripComments(read('../scripts/backfillDuplicatePaymentNotes.js'));
  const dryRunGuard = src.indexOf('if (!apply)');
  const firstUpdate = src.indexOf('UPDATE accounting SET note');
  assert.ok(dryRunGuard > -1 && firstUpdate > dryRunGuard,
    'the UPDATE must sit after the dry-run return');
});

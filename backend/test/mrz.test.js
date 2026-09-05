/**
 * Reading a passport's machine-readable zone.
 *
 * The gap this closes: LAM Kam To's passport, number H20447101, was filed as
 * "R978269(8)". That is his HKID, which a Hong Kong passport prints twice — down
 * the left edge and in the MRZ personal-number field. The extractor was asked
 * for "the ID" and had no rule for which of the two identifiers wins, so when
 * OCR mangled the passport number (it sits over a patterned security background
 * and the MRZ font renders 0 as O and 1 as I) the HKID was the only clean
 * ID-shaped string left. The brackets were the prompt's HKID formatting rule
 * being applied on top, and they appear nowhere on the document.
 *
 * Running the live prompt showed it gets the right answer on clean OCR and the
 * wrong one on degraded OCR, so this is not a prompt bug to argue with. The MRZ
 * is a checksummed format; it should be read arithmetically.
 *
 * The hard-won rule is in the last group. Neither check digit is sufficient —
 * four different strings satisfied both on the real sample — and edit distance
 * is actively misleading, because on a heavily garbled read an impostor sat one
 * correction away while the truth sat four. A number is believed only when the
 * raw read checks out, or when a repair is corroborated by the number printed
 * elsewhere on the page. Otherwise it stays blank.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMrz, checkDigit, readCheckDigit, compositeOk, mrzDate } = require('../src/utils/mrz');

// The real document, transcribed from the passport page.
const LINE1 = 'P<CHNLAM<<KAM<TO<<<<<<<<<<<<<<<<<<<<<<<<<<<<';
const LINE2 = 'H204471010CHN9911145M3001237<R9782698<<<<<28';
const HEADER = 'PASSPORT NO. H20447101\nHKPIC R9782698\n14 NOV 99';
const doc = (line2 = LINE2, header = HEADER) =>
  (header ? header + '\n' : '') + LINE1 + '\n' + line2;

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test('check digits verify against the real document', () => {
  // Worked by hand from ICAO 9303: weights 7,3,1; A=10..Z=35; filler 0.
  assert.equal(checkDigit('H20447101'), 0, 'document number');
  assert.equal(checkDigit('991114'), 5, 'date of birth');
  assert.equal(checkDigit('300123'), 7, 'date of expiry');
  assert.equal(compositeOk(LINE2), true, 'composite over the whole line');
});

test('a check digit position OCR-read as a letter is coerced, not rejected', () => {
  // The sample came back with "O" where the document check digit belongs.
  assert.equal(readCheckDigit('O'), 0);
  assert.equal(readCheckDigit('I'), 1);
  assert.equal(readCheckDigit('0'), 0);
  assert.equal(readCheckDigit('<'), 0);
  assert.equal(readCheckDigit('H'), null, 'a letter with no digit twin is not a check digit');
});

test('two-digit years land in the right century', () => {
  // A birth year ahead of today belongs to the last century; an expiry never does.
  assert.equal(mrzDate('991114'), '1999-11-14');
  assert.equal(mrzDate('300123', { future: true }), '2030-01-23');
  assert.equal(mrzDate('991301'), null, 'month 13 is not a date');
  assert.equal(mrzDate('nonsense'), null);
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

test('the real passport reads correctly end to end', () => {
  const r = parseMrz(doc());
  assert.equal(r.document_number, 'H20447101', 'the passport number, not the HKID');
  assert.equal(r.personal_number, 'R9782698', 'the HKID is captured, just not as the ID');
  assert.equal(r.birth_date, '1999-11-14');
  assert.equal(r.expiry_date, '2030-01-23');
  assert.equal(r.sex, 'M');
  assert.equal(r.nationality, 'CHN');
  assert.equal(r.last_name, 'LAM');
  assert.equal(r.first_name, 'KAM');
  assert.equal(r.middle_name, 'TO');
  assert.equal(r.document_type, 'passport');
  assert.equal(r.checks.document_number, 'ok');
});

test('the HKID is never returned as the document number', () => {
  // The whole point. R9782698 appears twice on this page and must never win.
  const r = parseMrz(doc());
  assert.notEqual(r.document_number, 'R9782698');
  assert.notEqual(r.document_number, 'R978269(8)');
});

test('text with no MRZ yields null rather than a guess', () => {
  assert.equal(parseMrz('Hi, my name is Kam To Lam, born 14 Nov 1999'), null);
  assert.equal(parseMrz(''), null);
  assert.equal(parseMrz(null), null);
});

test('OCR filler characters are normalised', () => {
  // Vision renders the filler as « or ≪ depending on the engine and the scan.
  const r = parseMrz(doc(LINE2.replace(/</g, '«'), HEADER));
  assert.ok(r, 'a line of « should still be recognised as an MRZ');
  assert.equal(r.document_number, 'H20447101');
});

// ---------------------------------------------------------------------------
// Repair, and the refusal to guess
// ---------------------------------------------------------------------------

test('a clean read needs no corroboration', () => {
  const r = parseMrz(doc(LINE2, ''));
  assert.equal(r.document_number, 'H20447101');
  assert.equal(r.checks.document_number, 'ok');
});

test('OCR damage is repaired when the printed number agrees', () => {
  for (const [label, damaged] of Object.entries({
    'one O for 0':        'H2O4471010CHN9911145M3001237<R9782698<<<<<28',
    'two errors':         'H2O44710I0CHN9911145M3001237<R9782698<<<<<28',
    'check digit too':    'H2O4471O1OCHN9911145M3001237<R9782698<<<<<28',
    'four errors':        'H2O447IOIOCHN9911145M3001237<R9782698<<<<<28',
  })) {
    const r = parseMrz(doc(damaged, HEADER));
    assert.equal(r.document_number, 'H20447101', `${label}: header should rescue the read`);
    assert.equal(r.checks.document_number, 'repaired-corroborated');
  }
});

test('damage with nothing to corroborate against leaves the field blank', () => {
  // This is the important one. Measured on the real sample, a heavily garbled
  // number has impostors NEARER the OCR text than the truth is: H2O447I0I sits
  // one correction away while H20447101 sits four. Any nearest-match rule
  // returns the impostor with total confidence. Blank is the honest answer.
  for (const damaged of [
    'H2O44710I0CHN9911145M3001237<R9782698<<<<<28',
    'H2O447IOIOCHN9911145M3001237<R9782698<<<<<28',
  ]) {
    const r = parseMrz(doc(damaged, ''));
    assert.equal(r.document_number, undefined, 'must not guess');
    assert.equal(r.checks.document_number, 'unverified');
  }
});

test('an impostor that satisfies both check digits is still rejected', () => {
  // H2O447I0I passes its own check digit AND the composite. It is one edit from
  // the OCR text. It is not the passport number, and it is not printed anywhere
  // on the page, so corroboration is what excludes it.
  const damaged = 'H2O447IOIOCHN9911145M3001237<R9782698<<<<<28';
  assert.equal(checkDigit('H2O447I0I'), readCheckDigit('O'),
    'the impostor really does satisfy the field digit');
  const r = parseMrz(doc(damaged, ''));
  assert.notEqual(r.document_number, 'H2O447I0I');
});

test('a destroyed number is never recovered from thin air', () => {
  const r = parseMrz(doc('XXXXXXXXXOCHN9911145M3001237<R9782698<<<<<28', HEADER));
  assert.equal(r.document_number, undefined);
});

test('dates and sex still come through when the number cannot be read', () => {
  // Refusing on one field must not throw away the fields that did verify.
  const r = parseMrz(doc('H2O447IOIOCHN9911145M3001237<R9782698<<<<<28', ''));
  assert.equal(r.birth_date, '1999-11-14');
  assert.equal(r.sex, 'M');
  assert.equal(r.expiry_date, '2030-01-23');
});

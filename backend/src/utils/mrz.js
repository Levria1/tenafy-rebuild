/**
 * Machine Readable Zone parsing, for the two lines across the bottom of a
 * passport.
 *
 * Why this exists: a Hong Kong passport carries TWO identifiers. The passport
 * number sits top right and again at the start of MRZ line 2, while the
 * holder's HKID is printed down the left edge and repeated in the MRZ personal
 * number field. Asking an LLM for "the ID" makes it choose, and when OCR
 * mangles the passport number — which is common, because it sits over a
 * patterned security background and the MRZ font turns 0 into O and 1 into I —
 * the HKID is the only clean ID-shaped string left and it wins. That is how
 * LAM Kam To's passport H20447101 was filed as R978269(8), his HKID, with the
 * bracketed check digit the prompt's HKID rule helpfully added.
 *
 * The MRZ is not a guessing problem. It is a fixed-width format where every
 * field carries its own check digit, so a read can be VERIFIED rather than
 * trusted, and a failed check can often be repaired by trying the handful of
 * substitutions OCR actually makes.
 *
 * TD3 (passport) line 2, 44 characters:
 *   1-9    document number        10  check digit
 *   11-13  nationality
 *   14-19  date of birth YYMMDD   20  check digit
 *   21     sex (M/F/<)
 *   22-27  date of expiry YYMMDD  28  check digit
 *   29-42  personal number            43  check digit
 *   44     composite check digit
 *
 * Line 1 holds the document type, issuing state and the name, surname first,
 * separated from the given names by a double filler.
 */

const LINE_LENGTH = 44;

// How far to search when repairing the document number. Generous, because the
// search result is never trusted on its own — every candidate must also be
// corroborated by the number printed elsewhere on the page, so widening this
// costs a little CPU rather than accuracy.
const MAX_DOC_EDITS = 4;

// The substitutions OCR actually makes on MRZ text, in both directions. Used
// only to repair a field whose check digit already failed, and only when the
// repair makes that check digit pass — so a wrong guess cannot survive.
const CONFUSIONS = {
  O: '0', '0': 'O',
  I: '1', '1': 'I',
  L: '1',
  S: '5', '5': 'S',
  B: '8', '8': 'B',
  Z: '2', '2': 'Z',
  G: '6', '6': 'G',
  D: '0',
  Q: '0',
  U: '0',
};

/**
 * A check digit position holds a digit or a filler, never a letter. OCR does not
 * know that, and will happily return O for 0 or I for 1 — in the sample that
 * started this, the document number's own check digit came back as "O". Coerce
 * the known confusions rather than treating the whole field as unreadable.
 */
function readCheckDigit(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch === '<') return 0;
  const alt = CONFUSIONS[ch];
  if (alt && alt >= '0' && alt <= '9') return alt.charCodeAt(0) - 48;
  return null;
}

/** Character value for the check-digit sum: digits are themselves, A=10..Z=35, filler 0. */
function charValue(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  if (ch === '<') return 0;
  return null; // anything else is not MRZ text
}

/** ICAO 9303 check digit: weights cycle 7,3,1 across the field, sum mod 10. */
function checkDigit(field) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]);
    if (v === null) return null;
    sum += v * weights[i % 3];
  }
  return sum % 10;
}

/**
 * Every candidate for `field` reachable by substituting up to `maxEdits`
 * characters from the confusion map, nearest first.
 *
 * Depth is bounded because the search is a liability as well as a repair: a
 * check digit is one decimal, so roughly one candidate in ten satisfies it by
 * chance. Two edits over nine characters can produce dozens of candidates, and
 * a plausible WRONG passport number is far more dangerous than a blank field —
 * nobody re-reads a number that looks fine. Beyond one edit the caller must
 * corroborate with the composite check digit before believing the result.
 */
function* candidates(field, maxEdits, start = 0, edits = 0) {
  yield { value: field, edits };
  if (edits >= maxEdits) return;
  for (let i = start; i < field.length; i++) {
    const alt = CONFUSIONS[field[i]];
    if (!alt) continue;
    const swapped = field.slice(0, i) + alt + field.slice(i + 1);
    yield* candidates(swapped, maxEdits, i + 1, edits + 1);
  }
}

/**
 * Try to make `field` satisfy `expected`. Returns the repaired field, or null.
 * One substitution by default; the caller raises the limit only when it can
 * check the answer against the composite digit afterwards.
 */
function repairField(field, expected, maxEdits = 1) {
  for (const { value } of candidates(field, maxEdits)) {
    if (checkDigit(value) === expected) return value;
  }
  return null;
}

/**
 * The composite check digit at position 44 covers the document number, both
 * dates and the personal number together with their own check digits. It is the
 * only thing in the MRZ that can corroborate a repair: a substitution that
 * satisfies one field's digit by luck will almost never also satisfy this one.
 */
function compositeField(line2) {
  return line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);
}

function compositeOk(line2) {
  const expected = readCheckDigit(line2[43]);
  if (expected === null) return false;
  return checkDigit(compositeField(line2)) === expected;
}

/**
 * Normalise a line of OCR text into MRZ alphabet. OCR renders the filler
 * character as «, ≪, k or a run of spaces depending on the engine.
 */
function normaliseLine(line) {
  return String(line || '')
    .toUpperCase()
    .replace(/[«»≪≫]/g, '<')
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * Pull the two TD3 lines out of arbitrary OCR text.
 *
 * Anchored on line 2's shape rather than line 1's, because line 1 starts with
 * "P<" which also appears in ordinary text, while line 2's run of fillers and
 * digits does not. Length is allowed to run slightly over or under 44: OCR
 * drops and doubles fillers at the end of a line constantly.
 */
function findLines(text) {
  const candidates = String(text || '').split(/[\r\n]+/).map(normaliseLine).filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    const line = candidates[i];
    if (line.length < 30) continue;
    // Line 1 of a TD3 begins with the document type then the issuing state.
    if (!/^[A-Z<][A-Z<]?[A-Z<]{3}/.test(line)) continue;
    if (!line.startsWith('P')) continue;
    const next = candidates[i + 1];
    if (!next || next.length < 30) continue;
    // Line 2 is mostly digits and fillers, and never starts a name.
    if (!/^[A-Z0-9<]{28,}$/.test(next)) continue;
    // Everything that is NOT the MRZ. The document number is also printed in
    // the header, and that read is independent of this one: different font,
    // different background, different failure modes. It is the only outside
    // evidence available, so keep it.
    const printed = candidates.filter((_, j) => j !== i && j !== i + 1).join(' ');
    return { line1: line.padEnd(LINE_LENGTH, '<').slice(0, LINE_LENGTH),
             line2: next.padEnd(LINE_LENGTH, '<').slice(0, LINE_LENGTH),
             printed };
  }
  return null;
}

/** YYMMDD to YYYY-MM-DD. The century pivot follows ICAO practice for birth dates. */
function mrzDate(yymmdd, { future = false } = {}) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  // Expiry dates are always ahead of us, so a two-digit year is this century.
  // Birth dates are behind, so a year beyond the current one belongs to the
  // last century — 99 is 1999, not 2099.
  const nowYY = Number(String(new Date().getUTCFullYear()).slice(2));
  const century = future ? 2000 : (yy > nowYY ? 1900 : 2000);
  return `${century + yy}-${mm}-${dd}`;
}

function cleanName(part) {
  return part.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the MRZ out of OCR text.
 *
 * @returns {object|null} null when there is no MRZ to read. Otherwise the
 *   fields that VERIFIED, plus `checks` recording what passed, failed or was
 *   repaired. A field whose check digit could not be satisfied is omitted
 *   rather than returned unverified.
 */
function parseMrz(text) {
  const lines = findLines(text);
  if (!lines) return null;

  const { line1, line2 } = lines;
  const out = { checks: {} };

  const readField = (raw, expectedChar, key) => {
    const expected = readCheckDigit(expectedChar);
    if (expected === null) { out.checks[key] = 'no-check-digit'; return null; }
    const repaired = repairField(raw, expected);
    if (repaired === null) { out.checks[key] = 'failed'; return null; }
    out.checks[key] = repaired === raw ? 'ok' : 'repaired';
    return repaired;
  };

  // The document number is the field OCR ruins most often, and it is the one
  // that must not be guessed. Neither check digit is enough to pick between
  // readings: on the real sample, four different nine-character strings
  // satisfied BOTH the field digit and the composite. Nor is edit distance —
  // measured on a heavily garbled read, the true number sat 4 corrections away
  // while an impostor sat 1. A nearest-match rule would have returned the
  // impostor with confidence.
  //
  // So there are exactly two ways to believe a document number:
  //   1. The raw read already satisfies both check digits. Nothing was wrong.
  //   2. A repaired candidate ALSO appears in the printed part of the page.
  //      The header number is a separate OCR read of separate ink, so agreement
  //      between the two is real evidence rather than more arithmetic.
  // Anything else is left blank for a person to type. A blank gets filled in; a
  // plausible wrong passport number is the one nobody ever re-reads.
  let documentNumber = null;
  const docExpected = readCheckDigit(line2[9]);
  const rawDoc = line2.slice(0, 9);
  const printedText = String(lines.printed || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (docExpected === null) {
    out.checks.document_number = 'no-check-digit';
  } else if (checkDigit(rawDoc) === docExpected && compositeOk(line2)) {
    documentNumber = rawDoc;
    out.checks.document_number = 'ok';
  } else {
    const corroborated = new Map();
    for (const { value, edits } of candidates(rawDoc, MAX_DOC_EDITS)) {
      if (checkDigit(value) !== docExpected) continue;
      if (!compositeOk(value + String(docExpected) + line2.slice(10))) continue;
      if (!printedText.includes(value.replace(/</g, ''))) continue;
      if (!corroborated.has(value) || corroborated.get(value) > edits) corroborated.set(value, edits);
    }
    if (corroborated.size === 1) {
      documentNumber = [...corroborated.keys()][0];
      out.checks.document_number = 'repaired-corroborated';
    } else {
      out.checks.document_number = corroborated.size > 1 ? 'ambiguous' : 'unverified';
    }
  }
  if (documentNumber) out.document_number = documentNumber.replace(/</g, '');

  const birth = readField(line2.slice(13, 19), line2[19], 'birth_date');
  if (birth) out.birth_date = mrzDate(birth);

  const expiry = readField(line2.slice(21, 27), line2[27], 'expiry_date');
  if (expiry) out.expiry_date = mrzDate(expiry, { future: true });

  const personal = line2.slice(28, 42);
  const personalCheck = readCheckDigit(line2[42]);
  // The personal number field is optional and its check digit is 0 or < when
  // unused, so a failure here is not worth repairing or reporting as an error.
  if (personal.replace(/</g, '') && checkDigit(personal) === personalCheck) {
    out.personal_number = personal.replace(/</g, '');
    out.checks.personal_number = 'ok';
  }

  const sex = line2[20];
  if (sex === 'M' || sex === 'F') out.sex = sex;

  const nationality = line2.slice(10, 13).replace(/</g, '');
  if (nationality) out.nationality = nationality;

  // Names: everything after the 5-character type-and-state prefix, surname and
  // given names split by the double filler.
  const nameZone = line1.slice(5);
  const [surname, given] = nameZone.split('<<');
  if (surname) out.last_name = cleanName(surname);
  if (given) {
    const parts = cleanName(given).split(' ').filter(Boolean);
    if (parts.length) out.first_name = parts[0];
    if (parts.length > 1) out.middle_name = parts.slice(1).join(' ');
  }

  out.document_type = line1[0] === 'P' ? 'passport' : line1.slice(0, 2).replace(/</g, '');
  return out;
}

module.exports = { parseMrz, checkDigit, repairField, readCheckDigit, findLines, mrzDate, charValue, compositeOk, compositeField };

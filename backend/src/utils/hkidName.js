/**
 * Read the holder's name off a Hong Kong ID card's OCR text.
 *
 * An HKID prints "SURNAME, Given Names". The given names are the romanised
 * Chinese given name (one word per Chinese character) plus any English name.
 * Staff rules (2026-11-03): the Chinese given name stays together as one name,
 * and whichever name comes first after the comma is the FIRST name; the other
 * is the middle name.
 *
 *     苗紅    MIU, Hung Nelly        →  first Hung,     middle Nelly,   last Miu
 *     陳大文  CHAN, Tai Man David    →  first Tai Man,  middle David,   last Chan
 *     陳大文  CHAN, David Tai Man    →  first David,    middle Tai Man, last Chan
 *
 * How many words belong to the Chinese name comes from the printed Chinese
 * name (its length minus the surname's syllables). Whether they come before or
 * after the English name is read from which words look like Cantonese
 * syllables. With no Chinese name read, the leading Cantonese-looking words
 * are taken as the Chinese name.
 *
 * Returns { first_name, last_name, middle_name? } or null when the text is not
 * an HKID or has no "SURNAME, Given" line; the caller then keeps what the LLM said.
 */

const CJK = /^[㐀-鿿]{2,5}$/;
const ROMAN_NAME = /^([A-Z][A-Z' -]*?)\s*,\s*([A-Za-z][A-Za-z' -]*)$/;
// A romanised Cantonese syllable: optional initial, vowels, optional final.
// "Hung", "Tai", "Man", "Siu", "Yeung" match; "Nelly", "David", "Peter" don't.
const CANTONESE = /^(?:(ng|ch|sh|ts|hw|kw|[bcdfghjklmnpstwy])?[aeiouy]{1,3}(ng|n|m|k|p|t|h)?|tsz|sze|tze|sz|ng|m)$/i;

const titled = (s) => s.split(/\s+/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const looksCantonese = (words) => words.length > 0 && words.every(w => CANTONESE.test(w));

function chineseNameNear(lines, idx) {
  for (let d = 1; d <= 3; d++) {
    for (const j of [idx - d, idx + d]) {
      if (lines[j] && CJK.test(lines[j])) return lines[j];
    }
  }
  return null;
}

function parseHkidName(text) {
  if (!text || !/IDENTITY\s*CARD|身份證/i.test(text)) return null;
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const idx = lines.findIndex(l => ROMAN_NAME.test(l));
  if (idx < 0) return null;
  const [, surname, givenRaw] = ROMAN_NAME.exec(lines[idx]);
  const given = givenRaw.trim().split(/\s+/);
  const surnameWords = surname.trim().split(/\s+/).length;

  let groups; // [firstName words, middleName words]
  const chinese = chineseNameNear(lines, idx);
  const k = chinese ? chinese.length - surnameWords : 0;
  if (k >= 1 && k <= given.length) {
    const head = given.slice(0, k);
    const tail = given.slice(given.length - k);
    const chineseLast = !looksCantonese(head) && looksCantonese(tail);
    groups = chineseLast
      ? [given.slice(0, given.length - k), tail]
      : [head, given.slice(k)];
  } else {
    // No usable Chinese name: the leading Cantonese-looking words are the
    // Chinese given name (at least the first word is the first name).
    let n = 0;
    while (n < given.length && CANTONESE.test(given[n])) n++;
    n = Math.max(1, n);
    groups = [given.slice(0, n), given.slice(n)];
  }

  const out = { last_name: titled(surname), first_name: titled(groups[0].join(' ')) };
  if (groups[1].length) out.middle_name = titled(groups[1].join(' '));
  return out;
}

module.exports = { parseHkidName };

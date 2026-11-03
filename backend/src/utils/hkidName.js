/**
 * Read the holder's name off a Hong Kong ID card's OCR text.
 *
 * An HKID prints the name as "SURNAME, Given Names", where the given names are
 * the romanised Chinese given name followed by any English name:
 *
 *     苗紅
 *     MIU, Hung Nelly        →  last Miu, first Hung, middle Nelly
 *     陳大文
 *     CHAN, Tai Man David    →  last Chan, first Tai Man, middle David
 *
 * Smart Extract left this to the LLM, which read "Nelly" as the first name.
 * Which words are the Chinese given name is not guesswork: each Chinese
 * character is one romanised syllable, so the printed Chinese name says how
 * many words belong to it (its length minus the surname's syllables).
 *
 * Returns { first_name, last_name, middle_name? } or null when the text is not
 * an HKID or the name can't be read with certainty; the caller then keeps
 * whatever the LLM said.
 */

const CJK = /^[㐀-鿿]{2,5}$/;
const ROMAN_NAME = /^([A-Z][A-Z' -]*?)\s*,\s*([A-Za-z][A-Za-z' -]*)$/;

const titled = (s) => s.split(/\s+/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');

function parseHkidName(text) {
  if (!text || !/IDENTITY\s*CARD|身份證/i.test(text)) return null;
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const idx = lines.findIndex(l => ROMAN_NAME.test(l));
  if (idx < 0) return null;
  const [, surnameRaw, givenRaw] = ROMAN_NAME.exec(lines[idx]);
  const surnameWords = surnameRaw.trim().split(/\s+/);
  const given = givenRaw.trim().split(/\s+/);

  // The Chinese name is printed just above the English one; take the nearest
  // all-Chinese line of 2–5 characters (skips 香港永久性居民身份證 and 女).
  let chinese = null;
  for (let d = 1; d <= 3 && !chinese; d++) {
    for (const j of [idx - d, idx + d]) {
      if (lines[j] && CJK.test(lines[j])) { chinese = lines[j]; break; }
    }
  }
  if (!chinese) return null;

  const givenSyllables = chinese.length - surnameWords.length;
  if (givenSyllables < 1 || givenSyllables > given.length) return null;

  const out = {
    last_name: titled(surnameRaw),
    first_name: titled(given.slice(0, givenSyllables).join(' ')),
  };
  const english = given.slice(givenSyllables).join(' ');
  if (english) out.middle_name = titled(english);
  return out;
}

module.exports = { parseHkidName };

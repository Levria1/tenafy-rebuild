/**
 * Read the holder's name off a Hong Kong ID card's OCR text.
 *
 * An HKID prints the name as "SURNAME, Given Names". Staff rule (2026-11-03):
 * the first name after the comma is the FIRST name, everything after it is the
 * middle name.
 *
 *     MIU, Hung Nelly        →  last Miu, first Hung, middle Nelly
 *     CHAN, Tai Man David    →  last Chan, first Tai, middle Man David
 *
 * Smart Extract left this to the LLM, which read "Nelly" as the first name.
 *
 * Returns { first_name, last_name, middle_name? } or null when the text is not
 * an HKID or has no "SURNAME, Given" line; the caller then keeps what the LLM said.
 */

const ROMAN_NAME = /^([A-Z][A-Z' -]*?)\s*,\s*([A-Za-z][A-Za-z' -]*)$/;

const titled = (s) => s.split(/\s+/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');

function parseHkidName(text) {
  if (!text || !/IDENTITY\s*CARD|身份證/i.test(text)) return null;
  const line = String(text).split(/\r?\n/).map(l => l.trim()).find(l => ROMAN_NAME.test(l));
  if (!line) return null;
  const [, surname, givenRaw] = ROMAN_NAME.exec(line);
  const given = givenRaw.trim().split(/\s+/);
  const out = { last_name: titled(surname), first_name: titled(given[0]) };
  if (given.length > 1) out.middle_name = titled(given.slice(1).join(' '));
  return out;
}

module.exports = { parseHkidName };

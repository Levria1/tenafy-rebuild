const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHkidName } = require('../src/utils/hkidName');

// Smart Extract filed "MIU, Hung Nelly" as first name Nelly, middle Hung. On an
// HKID the romanised Chinese given name comes first, then the English name.

const card = (cn, en) => `香港永久性居民身份證\nHONG KONG PERMANENT IDENTITY CARD\n${cn}\n${en}\n5379 4767\n出生日期 Date of Birth\n28-09-1967 女 F\n***AX`;

test('MIU, Hung Nelly: first name Hung, English name Nelly as middle', () => {
  assert.deepEqual(parseHkidName(card('苗紅', 'MIU, Hung Nelly')),
    { last_name: 'Miu', first_name: 'Hung', middle_name: 'Nelly' });
});

test('a two-syllable Chinese given name stays together', () => {
  assert.deepEqual(parseHkidName(card('陳大文', 'CHAN, Tai Man David')),
    { last_name: 'Chan', first_name: 'Tai Man', middle_name: 'David' });
  assert.deepEqual(parseHkidName(card('陳大文', 'CHAN, Tai Man')),
    { last_name: 'Chan', first_name: 'Tai Man' });
});

test('a two-character surname', () => {
  assert.deepEqual(parseHkidName(card('歐陽小明', 'AU YEUNG, Siu Ming Peter')),
    { last_name: 'Au Yeung', first_name: 'Siu Ming', middle_name: 'Peter' });
});

test('leaves it to the LLM when it cannot be sure', () => {
  assert.equal(parseHkidName('MIU, Hung Nelly\nPassport'), null);           // not an HKID
  assert.equal(parseHkidName(card('', 'MIU, Hung Nelly')), null);           // no Chinese name read
  assert.equal(parseHkidName(card('苗紅紅紅', 'MIU, Hung')), null);          // syllables don't fit
  assert.equal(parseHkidName(null), null);
});

test('Smart Extract applies the HKID rule over the LLM', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/tenant.js'), 'utf8');
  assert.match(src, /const hkidName = parseHkidName\(combined\)/);
});

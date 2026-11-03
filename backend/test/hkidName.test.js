const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHkidName } = require('../src/utils/hkidName');

// Smart Extract filed "MIU, Hung Nelly" as first name Nelly, middle Hung. Staff
// rules: the Chinese given name stays together; whichever name comes first
// after the comma is the first name, the other the middle name.

const card = (cn, en) => `香港永久性居民身份證\nHONG KONG PERMANENT IDENTITY CARD\n${cn}\n${en}\n5379 4767\n出生日期 Date of Birth\n28-09-1967 女 F\n***AX`;

test('MIU, Hung Nelly: first name Hung, middle Nelly', () => {
  assert.deepEqual(parseHkidName(card('苗紅', 'MIU, Hung Nelly')),
    { last_name: 'Miu', first_name: 'Hung', middle_name: 'Nelly' });
});

test('a three-character Chinese name keeps its two given syllables together', () => {
  assert.deepEqual(parseHkidName(card('陳大文', 'CHAN, Tai Man David')),
    { last_name: 'Chan', first_name: 'Tai Man', middle_name: 'David' });
  assert.deepEqual(parseHkidName(card('陳大文', 'CHAN, Tai Man')),
    { last_name: 'Chan', first_name: 'Tai Man' });
});

test('an English name printed first is the first name', () => {
  assert.deepEqual(parseHkidName(card('陳大文', 'CHAN, David Tai Man')),
    { last_name: 'Chan', first_name: 'David', middle_name: 'Tai Man' });
  assert.deepEqual(parseHkidName(card('苗紅', 'MIU, Nelly Hung')),
    { last_name: 'Miu', first_name: 'Nelly', middle_name: 'Hung' });
});

test('syllables without a vowel (Tsz, Sze) still count as Chinese', () => {
  assert.deepEqual(parseHkidName(card('', 'WONG, Tsz Kin Ivan')),
    { last_name: 'Wong', first_name: 'Tsz Kin', middle_name: 'Ivan' });
});

test('a two-character surname', () => {
  assert.deepEqual(parseHkidName(card('歐陽小明', 'AU YEUNG, Siu Ming Peter')),
    { last_name: 'Au Yeung', first_name: 'Siu Ming', middle_name: 'Peter' });
});

test('with no Chinese name read, the leading Cantonese words stay together', () => {
  assert.deepEqual(parseHkidName(card('', 'CHAN, Tai Man David')),
    { last_name: 'Chan', first_name: 'Tai Man', middle_name: 'David' });
  assert.deepEqual(parseHkidName(card('', 'MIU, Hung Nelly')),
    { last_name: 'Miu', first_name: 'Hung', middle_name: 'Nelly' });
  assert.deepEqual(parseHkidName(card('', 'CHAN, David Tai Man')),
    { last_name: 'Chan', first_name: 'David', middle_name: 'Tai Man' });
});

test('leaves it to the LLM when it is not an HKID name line', () => {
  assert.equal(parseHkidName('MIU, Hung Nelly\nPassport'), null);
  assert.equal(parseHkidName('HONG KONG PERMANENT IDENTITY CARD\nno name here'), null);
  assert.equal(parseHkidName(null), null);
});

test('Smart Extract applies the HKID rule over the LLM', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/tenant.js'), 'utf8');
  assert.match(src, /const hkidName = parseHkidName\(combined\)/);
});

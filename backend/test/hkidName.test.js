const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHkidName } = require('../src/utils/hkidName');

// Smart Extract filed "MIU, Hung Nelly" as first name Nelly, middle Hung. Staff
// rule: the first word after the comma is the first name, the rest the middle.

const card = (cn, en) => `香港永久性居民身份證\nHONG KONG PERMANENT IDENTITY CARD\n${cn}\n${en}\n5379 4767\n出生日期 Date of Birth\n28-09-1967 女 F\n***AX`;

test('MIU, Hung Nelly: first name Hung, English name Nelly as middle', () => {
  assert.deepEqual(parseHkidName(card('苗紅', 'MIU, Hung Nelly')),
    { last_name: 'Miu', first_name: 'Hung', middle_name: 'Nelly' });
});

test('first word after the comma is the first name, the rest is the middle name', () => {
  assert.deepEqual(parseHkidName(card('陳大文', 'CHAN, Tai Man David')),
    { last_name: 'Chan', first_name: 'Tai', middle_name: 'Man David' });
  assert.deepEqual(parseHkidName(card('陳文', 'CHAN, Man')), { last_name: 'Chan', first_name: 'Man' });
  assert.deepEqual(parseHkidName(card('歐陽小明', 'AU YEUNG, Siu Ming')),
    { last_name: 'Au Yeung', first_name: 'Siu', middle_name: 'Ming' });
  // The Chinese name line is not needed.
  assert.deepEqual(parseHkidName(card('', 'MIU, Hung Nelly')),
    { last_name: 'Miu', first_name: 'Hung', middle_name: 'Nelly' });
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

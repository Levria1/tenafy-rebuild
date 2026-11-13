const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicLabelFields } = require('../src/utils/publicPropertyLabel');

test('publicLabelFields: the live Pearl City Mansion shape passes through', () => {
  const row = {
    public_label: '22-36 Paterson St, Causeway Bay',
    public_building_name: 'Pearl City Mansion',
    public_aliases: ['Pearl City Mansion', 'PCM', '12-B6', '12-C1'],
  };
  assert.deepEqual(publicLabelFields(row), {
    public_label: '22-36 Paterson St, Causeway Bay',
    public_building_name: 'Pearl City Mansion',
    public_aliases: ['Pearl City Mansion', 'PCM', '12-B6', '12-C1'],
  });
});

test('publicLabelFields: unset fields are null, not empty strings or arrays', () => {
  assert.deepEqual(publicLabelFields({ public_label: null, public_building_name: '  ', public_aliases: null }),
    { public_label: null, public_building_name: null, public_aliases: null });
  assert.deepEqual(publicLabelFields({ public_aliases: [] }).public_aliases, null);
  assert.deepEqual(publicLabelFields(undefined),
    { public_label: null, public_building_name: null, public_aliases: null });
});

test('publicLabelFields: aliases from a JSON string, trimmed and deduplicated', () => {
  // Live rows hold duplicates such as ["Hillier","Hillier"].
  assert.deepEqual(publicLabelFields({ public_aliases: '[" Hillier ","hillier","", null, 7]' }).public_aliases,
    ['Hillier', '7']);
  assert.equal(publicLabelFields({ public_aliases: 'not json' }).public_aliases, null);
  assert.equal(publicLabelFields({ public_aliases: '{"a":1}' }).public_aliases, null);
});

test('tripwire: /properties selects the label columns and both routes normalise them', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/public.js'), 'utf8');
  const list = src.slice(src.indexOf("router.get('/properties',"), src.indexOf("router.get('/properties/:id',"));
  const select = list.slice(list.indexOf('SELECT'), list.indexOf('FROM property p'));
  assert.match(select, /p\.public_label, p\.public_building_name, p\.public_aliases/);
  assert.match(list, /\.\.\.publicLabelFields\(p\)/);
  const detail = src.slice(src.indexOf("router.get('/properties/:id',"), src.indexOf("router.get('/units',"));
  assert.match(detail, /\.\.\.publicLabelFields\(properties\[0\]\)/);
});

/**
 * Full property address on contracts and in the chatbot. Reported from a real lease:
 * "Unit 26, 12-B6 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay, Causeway Bay,
 * Hong Kong" — the street address already ends with the district. Cases below are the
 * nine real Tane Residence properties that had it typed in twice (2026-10-09).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fullAddress } = require('../src/utils/propertyAddress');

test('a district already in the street address is not repeated', () => {
  assert.equal(fullAddress({
    street_address: '12-B6 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay',
    district: 'Causeway Bay', city: 'Hong Kong',
  }), '12-B6 Pearl City Mansion, 22-36 Paterson Street, Causeway Bay, Hong Kong');
});

test('district and city both already present: nothing is appended', () => {
  assert.equal(fullAddress({ street_address: '15 Tai Yuen St, Wan Chai, Hong Kong', district: 'Wan Chai', city: 'Hong Kong' }),
    '15 Tai Yuen St, Wan Chai, Hong Kong');
});

test('a city that is only a word inside the district is still added', () => {
  // "Kowloon City" is a district; the city "Kowloon" is a separate part and belongs.
  assert.equal(fullAddress({ street_address: '23 Fuk Lo Tsun Road, Kowloon City', district: 'Kowloon City', city: 'Kowloon' }),
    '23 Fuk Lo Tsun Road, Kowloon City, Kowloon');
});

test('matching ignores case, surrounding spaces and a stray leading space', () => {
  assert.equal(fullAddress({ street_address: ' 8 Cleverly Street,  sheung wan ', district: 'Sheung Wan', city: 'Hong Kong' }),
    '8 Cleverly Street,  sheung wan, Hong Kong');
});

test('a clean street address gets district and city appended as before', () => {
  assert.equal(fullAddress({ street_address: '88 Hennessy Road', district: 'Causeway Bay', city: 'Hong Kong Island' }),
    '88 Hennessy Road, Causeway Bay, Hong Kong Island');
});

test('missing parts are skipped, and district equal to city prints once', () => {
  assert.equal(fullAddress({ street_address: '', district: 'Central', city: '' }), 'Central');
  assert.equal(fullAddress({ street_address: '1 Queen\'s Road', district: 'Hong Kong', city: 'Hong Kong' }), '1 Queen\'s Road, Hong Kong');
  assert.equal(fullAddress(null), '');
});

test('the lease template and the chatbot both use the shared helper', () => {
  const { VARIABLES } = require('../src/services/leaseTemplateVariables');
  const v = VARIABLES.find(x => x.key === 'PROPERTY_FULL_ADDRESS');
  assert.equal(v.resolve({ property: { street_address: '3 Jervois Street, Sheung Wan', district: 'Sheung Wan', city: 'Hong Kong' } }),
    '3 Jervois Street, Sheung Wan, Hong Kong');
  const chat = fs.readFileSync(path.join(__dirname, '../src/services/chatTools.js'), 'utf8');
  assert.match(chat, /address: fullAddress\(r\),/);
  assert.doesNotMatch(chat, /\[r\.street_address, r\.district, r\.city\]\.filter\(Boolean\)\.join/);
});

test('unit property-info is org-scoped and returns the fields the unit page shows', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/property.js'), 'utf8');
  const start = src.indexOf("router.get('/unit/:unit_id/property-info'");
  const body = src.slice(start, src.indexOf('});', start));
  assert.match(body, /WHERE u\.id = \? AND p\.org_id = \?/);
  assert.match(body, /\[unitId, req\.user\.orgId\]/);
  for (const col of ['p.district', 'p.year_of_built', 'p.zip_code', 'p.mls']) assert.ok(body.includes(col), col);

  const page = fs.readFileSync(path.join(__dirname, '../../frontend/src/app/property/[id]/unit/[unitid]/page.js'), 'utf8');
  for (const field of ['propertyInfo?.district', 'propertyInfo?.year_of_built', 'propertyInfo?.zip_code', 'propertyInfo?.mls']) {
    assert.ok(page.includes(field), `unit page reads ${field}`);
  }
});

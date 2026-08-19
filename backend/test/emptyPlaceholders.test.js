const test = require('node:test');
const assert = require('node:assert/strict');
const { findEmptyPlaceholders } = require('../src/services/leaseTemplateVariables');

// A missing value resolves to '' and the document prints the LABEL with nothing after it —
// "I.D.No:" followed by white space. That reads as a broken placeholder when it is really
// missing data, and on a signed tenancy agreement an empty identification field is a
// defect. These make the difference detectable before the contract is sent.

const ctx = () => ({
  tenant: { first_name: 'Raheem', last_name: 'Soomro', id_card: null, email: 'r@example.com', phone: '' },
  lease: { start_date: '2026-08-19', end_date: '2027-08-18' },
});

test('a placeholder with no data behind it is reported, with its human label', () => {
  const found = findEmptyPlaceholders(
    ['<p>Name: {{TENANT_NAME}} I.D.No: {{TENANT_ID_CARD}}</p>'], ctx());
  assert.deepEqual(found, [{ key: 'TENANT_ID_CARD', label: 'Tenant HKID / passport' }]);
});

test('an empty string counts as blank, not just null', () => {
  // phone is '' — it renders as nothing, so the contract has a dangling label either way.
  const found = findEmptyPlaceholders(['{{TENANT_PHONE}}'], ctx()).map(f => f.key);
  assert.deepEqual(found, ['TENANT_PHONE']);
});

test('populated placeholders are not reported', () => {
  assert.deepEqual(findEmptyPlaceholders(['{{TENANT_NAME}} {{TENANT_EMAIL}}'], ctx()), []);
});

test('a layout marker is not mistaken for missing data', () => {
  // PAGE_BREAK resolves to a marker token, not a value; flagging it would train staff to
  // ignore the warning.
  assert.deepEqual(findEmptyPlaceholders(['{{PAGE_BREAK}}'], ctx()), []);
});

test('unknown placeholders are left alone — they stay visible in the document', () => {
  assert.deepEqual(findEmptyPlaceholders(['{{NOT_A_REAL_KEY}}'], ctx()), []);
});

test('each field is reported once even when it appears repeatedly or across parts', () => {
  const found = findEmptyPlaceholders(
    ['{{TENANT_ID_CARD}} and again {{TENANT_ID_CARD}}', '{{TENANT_ID_CARD}}'], ctx());
  assert.equal(found.length, 1);
});

test('header and footer are checked too, not just the body', () => {
  const found = findEmptyPlaceholders([null, '{{TENANT_ID_CARD}}', undefined], ctx()).map(f => f.key);
  assert.deepEqual(found, ['TENANT_ID_CARD']);
});

test('a resolver that throws does not break the check', () => {
  // One bad field must not stop the rest being reported.
  assert.doesNotThrow(() => findEmptyPlaceholders(['{{TENANT_ID_CARD}}'], null));
});

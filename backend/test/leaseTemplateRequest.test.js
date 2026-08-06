const test = require('node:test');
const assert = require('node:assert');

const { resolveWithData } = require('../src/services/leaseTemplateResolver');

// P1 restricts to T2/T3; P9 has no allowlist row, so it is unrestricted.
const data = () => ({
  templates: [{ id: 'T1', is_default: 1 }, { id: 'T2', is_default: 0 }, { id: 'T3', is_default: 0 }],
  allowByProperty: new Map([['P1', ['T2', 'T3']]]),
});

test('no requested template: unchanged behaviour (own → allowlist → default)', () => {
  assert.equal(resolveWithData({ property_id: 'P1', template_id: 'T3' }, data()), 'T3');
  assert.equal(resolveWithData({ property_id: 'P1', template_id: null }, data()), 'T2');
  assert.equal(resolveWithData({ property_id: 'P9', template_id: null }, data()), 'T1');
});

test('requested template is honoured when allowed for the property', () => {
  // The e-sign review screen previews the real lease against the chosen template.
  assert.equal(resolveWithData({ property_id: 'P1', template_id: null }, data(), 'T3'), 'T3');
  assert.equal(resolveWithData({ property_id: 'P9', template_id: null }, data(), 'T2'), 'T2');
});

test('requested template is REJECTED when not permitted for the property', () => {
  // T1 exists but is not in P1's allowlist — must not render another property's
  // contract, and must not silently substitute a different template either.
  assert.equal(resolveWithData({ property_id: 'P1', template_id: null }, data(), 'T1'), null);
  assert.equal(resolveWithData({ property_id: 'P1', template_id: 'T2' }, data(), 'T1'), null);
});

test('requested template that does not exist is rejected', () => {
  assert.equal(resolveWithData({ property_id: 'P9', template_id: null }, data(), 'NOPE'), null);
});

test('a request never overrides the allowlist even for the org default', () => {
  const chosen = resolveWithData({ property_id: 'P1', template_id: null }, data(), 'T1');
  assert.notEqual(chosen, 'T1', 'the org default must not bypass a property allowlist');
});

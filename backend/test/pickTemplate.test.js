const test = require('node:test');
const assert = require('node:assert');
const { pickTemplate } = require('../src/utils/pickTemplate');

test('pickTemplate: null/empty -> null', () => {
  assert.strictEqual(pickTemplate(null), null);
  assert.strictEqual(pickTemplate([]), null);
});

test('pickTemplate: prefers is_default_template', () => {
  const rows = [
    { id: '1', is_default_template: 0, created_time: '2026-02-01' },
    { id: '2', is_default_template: 1, created_time: '2026-01-01' },
  ];
  assert.strictEqual(pickTemplate(rows).id, '2');
});

test('pickTemplate: no default -> newest by created_time', () => {
  const rows = [
    { id: '1', is_default_template: 0, created_time: '2026-01-01' },
    { id: '2', is_default_template: 0, created_time: '2026-03-01' },
  ];
  assert.strictEqual(pickTemplate(rows).id, '2');
});

test('pickTemplate: handles string/buffer-ish default flag', () => {
  const rows = [
    { id: '1', is_default_template: '0', created_time: '2026-01-01' },
    { id: '2', is_default_template: '1', created_time: '2026-01-01' },
  ];
  assert.strictEqual(pickTemplate(rows).id, '2');
});

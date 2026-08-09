const test = require('node:test');
const assert = require('node:assert');
const { resolveExtractMode } = require('../src/utils/inquiryFacts');

test('exact lowercase staging enables inquiry fact staging mode', () => {
  assert.equal(resolveExtractMode('staging'), 'staging');
});

test('unset or empty extract mode defaults to notes', () => {
  assert.equal(resolveExtractMode(undefined), 'notes');
  assert.equal(resolveExtractMode(''), 'notes');
});

test('only exact lowercase staging opts in', () => {
  assert.equal(resolveExtractMode('notes'), 'notes');
  assert.equal(resolveExtractMode('STAGING'), 'notes');
  assert.equal(resolveExtractMode('true'), 'notes');
  assert.equal(resolveExtractMode('1'), 'notes');
});

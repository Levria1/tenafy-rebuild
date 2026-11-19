import assert from 'node:assert/strict';
import test from 'node:test';
import { amountInMinorUnits, updateQueue } from './statement.mjs';

test('amounts preserve currency precision and reject ambiguous formats', () => {
  assert.equal(amountInMinorUnits('1,234.50', 'HKD'), 123450);
  assert.equal(amountInMinorUnits('40', 'JPY'), 40);
  assert.equal(amountInMinorUnits('7.125', 'KWD'), 7125);
  assert.equal(amountInMinorUnits('7.125', 'HKD'), null);
  assert.equal(amountInMinorUnits('1.234,50', 'HKD'), null);
  assert.equal(amountInMinorUnits('90071992547409.92', 'HKD'), null);
  assert.equal(amountInMinorUnits('5', null), null);
});

test('row suffix distinguishes identical payments across page changes', () => {
  const queue = new Map();
  const first = { suffix: 'a', date: '2026-11-19', amount: '7.50', direction: 'Received' };
  const second = { ...first, suffix: 'b' };
  updateQueue(queue, [first, second], 'HKD');
  assert.equal(queue.size, 2);
  updateQueue(queue, [second], 'HKD');
  assert.equal(queue.get('a').current, false);
  assert.equal(queue.get('b').current, true);
  assert.equal(queue.get('b').minorUnits, 750);
  updateQueue(queue, [second, second], 'HKD');
  assert.equal(queue.has('b'), false);
});

const test = require('node:test');
const assert = require('node:assert');
const { routeChatSearch, mapTaneChatResult } = require('../src/utils/chatSearchMap');

test('routeChatSearch defaults to both', () => {
  assert.equal(routeChatSearch({}), 'both');
});

test('routeChatSearch routes explicit source', () => {
  assert.equal(routeChatSearch({ source: 'tenafy' }), 'local');
  assert.equal(routeChatSearch({ source: 'tanechat' }), 'tanechat');
});

test('routeChatSearch routes explicit channel', () => {
  assert.equal(routeChatSearch({ channel: 'staff-internal' }), 'local');
  assert.equal(routeChatSearch({ channel: 'whatsapp' }), 'tanechat');
});

test('routeChatSearch lets channel override source', () => {
  assert.equal(routeChatSearch({ source: 'tenafy', channel: 'whatsapp' }), 'tanechat');
});

test('routeChatSearch treats unknown source as both', () => {
  assert.equal(routeChatSearch({ source: 'unknown' }), 'both');
});

test('routeChatSearch normalises mixed case and padded source', () => {
  assert.equal(routeChatSearch({ source: ' TENAFY ' }), 'local');
});

test('mapTaneChatResult maps inbound messages as prospect messages', () => {
  const mapped = mapTaneChatResult({
    conversation_id: 'conv-1',
    timestamp: '2026-08-09T09:34:45.000Z',
    direction: 'inbound',
    content: 'hello',
    contact: { name: 'Ameerul', phone: '+85290000000', channel: 'email' },
    deep_link: 'https://chat.test/inbox?chatId=conv-1',
  });

  assert.equal(mapped.conversation_id, 'conv-1');
  assert.equal(mapped.session_id, undefined);
  assert.equal(mapped.source, 'tanechat');
  assert.equal(mapped.channel, 'email');
  assert.equal(mapped.prospect, 'Ameerul');
  assert.equal(mapped.who, 'prospect');
  assert.equal(mapped.said, 'hello');
  assert.equal(mapped.at, '2026-08-09T09:34:45.000Z');
  assert.equal(mapped.link, 'https://chat.test/inbox?chatId=conv-1');
});

test('mapTaneChatResult maps outbound messages as assistant messages', () => {
  assert.equal(mapTaneChatResult({ direction: 'outbound' }).who, 'assistant');
});

test('mapTaneChatResult falls back to phone then empty prospect', () => {
  assert.equal(mapTaneChatResult({ contact: { phone: '+85290000000' } }).prospect, '+85290000000');
  assert.equal(mapTaneChatResult({ contact: {} }).prospect, '');
});

test('mapTaneChatResult falls back to whatsapp channel without contact', () => {
  const mapped = mapTaneChatResult({ contact: null });
  assert.equal(mapped.channel, 'whatsapp');
  assert.equal(mapped.prospect, '');
});

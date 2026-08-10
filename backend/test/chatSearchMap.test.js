const test = require('node:test');
const assert = require('node:assert');
const {
  routeChatSearch, mapTaneChatResult,
  looksLikePhone, normalizePhone, buildTaneChatSearchParams,
} = require('../src/utils/chatSearchMap');

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
  assert.equal(routeChatSearch({ channel: 'booking' }), 'tanechat');
  assert.equal(routeChatSearch({ channel: ' AIRBNB ' }), 'tanechat');
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

// ── phone-selector search (TaneChat shipped keyword-less lookup by phone) ─────

test('looksLikePhone accepts numbers in common written forms', () => {
  assert.equal(looksLikePhone('85366369171'), true);
  assert.equal(looksLikePhone('+852 6636 9171'), true);
  assert.equal(looksLikePhone('(852) 6636-9171'), true);
});

test('looksLikePhone rejects names, emails and short digit strings', () => {
  assert.equal(looksLikePhone('Virginia'), false);
  assert.equal(looksLikePhone('eric@example.com'), false);
  assert.equal(looksLikePhone('5B'), false);
  assert.equal(looksLikePhone('123456'), false);
  assert.equal(looksLikePhone(''), false);
  assert.equal(looksLikePhone(null), false);
});

test('normalizePhone strips punctuation and keeps digits', () => {
  assert.equal(normalizePhone('+852 6636-9171'), '85266369171');
  assert.equal(normalizePhone(null), '');
});

test('buildTaneChatSearchParams needs a keyword or a phone', () => {
  assert.equal(buildTaneChatSearchParams({ limit: 25 }), null);
  assert.equal(buildTaneChatSearchParams({ keyword: '   ', limit: 25 }), null);
});

test('buildTaneChatSearchParams sends phone alone', () => {
  assert.deepEqual(
    buildTaneChatSearchParams({ phone: '+852 6636 9171', limit: 10 }),
    { limit: 10, phone: '85266369171' }
  );
});

test('buildTaneChatSearchParams sends keyword and phone together', () => {
  const p = buildTaneChatSearchParams({ keyword: ' deposit ', phone: '85366369171', limit: 5 });
  assert.equal(p.q, 'deposit');
  assert.equal(p.phone, '85366369171');
});

// Their API accepts from/to and silently IGNORES since/until, so a date bound
// passed under the wrong name would drop and old messages would look current.
test('buildTaneChatSearchParams maps since/until onto from/to', () => {
  const p = buildTaneChatSearchParams({ keyword: 'x', since: '2026-08-01', until: '2026-08-09', limit: 5 });
  assert.equal(p.from, '2026-08-01');
  assert.equal(p.to, '2026-08-09');
  assert.equal('since' in p, false);
  assert.equal('until' in p, false);
});

test('buildTaneChatSearchParams ignores malformed dates', () => {
  const p = buildTaneChatSearchParams({ keyword: 'x', since: 'last week', until: '2026-8-9', limit: 5 });
  assert.equal('from' in p, false);
  assert.equal('to' in p, false);
});

test('routeChatSearch treats the airbnb OTA channel as a TaneChat channel', () => {
  assert.equal(routeChatSearch({ channel: 'airbnb' }), 'tanechat');
});

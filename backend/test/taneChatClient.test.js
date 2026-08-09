/**
 * TaneChat integration client + search_whatsapp tool (stubbed; no real HTTP).
 */

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const https = require('https');

process.env.TANECHAT_API_URL = 'https://chat.test/api/integration';
process.env.TANECHAT_API_KEY = 'tc-test';
process.env.TANECHAT_TIMEOUT_MS = '1000';

const taneChat = require('../src/services/taneChatClient');
const chatTools = require('../src/services/chatTools');

const origRequest = https.request;
const origLog = console.log, origWarn = console.warn, origErr = console.error;
function mute() { console.log = console.warn = console.error = () => {}; }
function unmute() { console.log = origLog; console.warn = origWarn; console.error = origErr; }

function stubHttps(handler) {
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      try {
        handler(opts, cb, req);
      } catch (e) {
        req.emit('error', e);
      }
    };
    req.destroy = (err) => { if (err) req.emit('error', err); };
    return req;
  };
}

function respond(cb, statusCode, body, headers = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  cb(res);
  res.emit('data', JSON.stringify(body));
  res.emit('end');
}

test.afterEach(() => {
  https.request = origRequest;
  unmute();
});

test('searchMessages builds querystring, omits empty params, clamps limit to 100', async () => {
  let seen;
  stubHttps((opts, cb) => {
    seen = opts;
    respond(cb, 200, { results: [] });
  });

  const r = await taneChat.searchMessages({
    amount: 13800,
    q: '',
    phone: null,
    from: undefined,
    direction: 'inbound',
    limit: 500,
  });

  assert.deepEqual(r, { results: [] });
  assert.equal(seen.method, 'GET');
  assert.equal(seen.hostname, 'chat.test');
  assert.equal(seen.path, '/api/integration/search/messages?amount=13800&direction=inbound&limit=100');
  assert.equal(seen.headers.Authorization, 'Bearer tc-test');
  assert.equal(seen.headers['X-API-Key'], 'tc-test');
});

test('non-2xx rejects with status and server error message', async () => {
  stubHttps((opts, cb) => {
    respond(cb, 400, { error: 'missing filters' });
  });

  await assert.rejects(
    () => taneChat.searchMessages({ amount: 1 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /TaneChat 400: missing filters/);
      return true;
    }
  );
});

test('429 rejects with retryAfterSeconds from Retry-After header', async () => {
  stubHttps((opts, cb) => {
    respond(cb, 429, { error: 'rate limit' }, { 'retry-after': '17' });
  });

  await assert.rejects(
    () => taneChat.searchMessages({ q: 'rent' }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSeconds, 17);
      return true;
    }
  );
});

test('isConfigured false when key unset, and searchMessages rejects before HTTP', async () => {
  const cfg = require('../src/config');
  const oldKey = cfg.chat.taneChat.apiKey;
  let called = false;
  cfg.chat.taneChat.apiKey = '';
  stubHttps(() => { called = true; });

  try {
    assert.equal(taneChat.isConfigured(), false);
    await assert.rejects(() => taneChat.searchMessages({ q: 'rent' }), /TANECHAT_API_KEY not configured/);
    assert.equal(called, false);
  } finally {
    cfg.chat.taneChat.apiKey = oldKey;
  }
});

test('search_whatsapp rejects calls with no filters', async () => {
  const tool = chatTools.ALL_BY_NAME.search_whatsapp;
  const r = await tool.execute({}, { from: '2026-07-01', limit: 5 });
  assert.match(r.error, /at least one search filter/);
});

// TaneChat used to 400 on a phone-only query, so we rejected it locally. They
// shipped keyword-less lookup by phone on 2026-08-09 (verified live), which is
// what "show me everything this person said" needs — so it must now go through.
test('search_whatsapp sends a phone-only search to TaneChat', async () => {
  const tool = chatTools.ALL_BY_NAME.search_whatsapp;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  let seen = null;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async (params) => { seen = params; return { results: [] }; };
  try {
    const r = await tool.execute({}, { phone: '+85290001234' });
    assert.equal(r.error, undefined, 'phone alone is a valid selector now');
    assert.equal(seen.phone, '+85290001234');
    assert.equal(r.count, 0);
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

test('search_whatsapp trims and truncates payload before returning it', async () => {
  const tool = chatTools.ALL_BY_NAME.search_whatsapp;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  const long = 'x'.repeat(450);
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async (params) => {
    assert.equal(params.limit, 100);
    assert.equal(params.amount, 13800);
    return {
      results: [{
        message_id: 'm1',
        conversation_id: 'c1',
        timestamp: '2026-07-17T05:54:50.330Z',
        direction: 'inbound',
        content: long,
        message_type: 'text',
        had_media: true,
        contact: { name: 'A Name', phone: '+85290001234', channel: 'whatsapp', extra: 'drop' },
        deep_link: 'https://chat.test/inbox',
        context: [
          { message_id: 'ctx', timestamp: '2026-07-17T05:53:00.000Z', direction: 'outbound', content: ' y '.repeat(250), had_media: false },
        ],
      }],
      next_cursor: 'cursor',
    };
  };

  try {
    const r = await tool.execute({}, { amount: 13800, from: '2026-02-01', limit: 500 });
    assert.equal(r.count, 1);
    assert.equal(r.results[0].content.length, 401);
    assert.equal(r.results[0].content.endsWith('…'), true);
    assert.deepEqual(Object.keys(r.results[0]).sort(), [
      'contact', 'content', 'context', 'conversation_id', 'deep_link', 'direction', 'message_id', 'timestamp',
    ].sort());
    assert.deepEqual(r.results[0].contact, { name: 'A Name', phone: '+85290001234', channel: 'whatsapp' });
    assert.deepEqual(Object.keys(r.results[0].context[0]).sort(), ['content', 'direction', 'timestamp'].sort());
    assert.match(r.note, /2026-03-01/);
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

test('search_whatsapp returns error object when client fails', async () => {
  const tool = chatTools.ALL_BY_NAME.search_whatsapp;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async () => { throw new Error('TaneChat 500: server error'); };

  try {
    const r = await tool.execute({}, { q: 'rent' });
    assert.deepEqual(r, { error: 'TaneChat 500: server error' });
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

test('search_whatsapp is internal-only: absent from prospect tools and present internally', () => {
  const prospect = chatTools.toolsForCapabilities({
    can_search: true,
    can_show_details: true,
    can_book_viewings: true,
    can_capture_leads: true,
    can_search_inquiries: true,
    can_search_leases: true,
    can_search_invoices: true,
    can_search_services: true,
    can_search_documents: true,
  });
  const internal = chatTools.toolsForInternal();
  assert.ok(chatTools.INTERNAL_ONLY.has('search_whatsapp'));
  assert.ok(!prospect.byName.search_whatsapp);
  assert.ok(internal.byName.search_whatsapp);
});

// ── search_chats: prospect → phone resolution against the live TaneChat API ──

function fakePool(phoneRows) {
  return {
    execute: async () => [phoneRows, []],
    query: async () => [[], []],
  };
}

test('search_chats sends a phone-shaped prospect straight through, no keyword', async () => {
  const tool = chatTools.ALL_BY_NAME.search_chats;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  let seen = null;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async (params) => {
    seen = params;
    return { results: [{ conversation_id: 'c1', timestamp: '2026-08-09T10:00:00.000Z',
                         direction: 'inbound', content: 'Hello', contact: { name: 'Eric', phone: '+8615069758263' } }] };
  };
  try {
    const r = await tool.execute({ pool: fakePool([]) }, { source: 'tanechat', prospect: '+8615069758263' });
    assert.equal(seen.phone, '8615069758263');
    assert.equal('q' in seen, false, 'no keyword was given, so none should be sent');
    assert.equal(r.count, 1);
    assert.equal(r.messages[0].conversation_id, 'c1');
    assert.equal(r.messages[0].who, 'prospect');
    assert.equal(r.notices, undefined, 'a resolvable contact needs no notice');
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

test('search_chats resolves a name to a phone from our own records', async () => {
  const tool = chatTools.ALL_BY_NAME.search_chats;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  let seen = null;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async (params) => { seen = params; return { results: [] }; };
  try {
    await tool.execute({ pool: fakePool([{ phone: '+852 6636 9171' }]) },
                       { source: 'tanechat', prospect: 'Virginia' });
    assert.equal(seen.phone, '85266369171');
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

// The failure that matters: an unfilterable search must not look like an answer.
test('search_chats notices an unresolvable name instead of returning a bare empty list', async () => {
  const tool = chatTools.ALL_BY_NAME.search_chats;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  let called = 0;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async () => { called++; return { results: [] }; };
  try {
    const r = await tool.execute({ pool: fakePool([]) }, { source: 'tanechat', prospect: 'Nobody We Know' });
    assert.equal(called, 0, 'no keyword and no phone means nothing to ask');
    assert.ok(Array.isArray(r.notices) && r.notices.length >= 1);
    const codes = r.notices.map(n => n.unavailable);
    assert.ok(codes.includes('tanechat_prospect_unresolved'));
    assert.ok(codes.includes('tanechat_requires_keyword_or_phone'));
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

test('search_chats still searches by keyword when the name is unresolvable', async () => {
  const tool = chatTools.ALL_BY_NAME.search_chats;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  let seen = null;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async (params) => { seen = params; return { results: [] }; };
  try {
    const r = await tool.execute({ pool: fakePool([]) },
                                 { source: 'tanechat', prospect: 'Nobody', keyword: 'deposit' });
    assert.equal(seen.q, 'deposit');
    assert.equal('phone' in seen, false);
    const codes = (r.notices || []).map(n => n.unavailable);
    assert.ok(codes.includes('tanechat_prospect_unresolved'), 'must say the results are unfiltered');
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

test('search_chats maps since/until to the date bounds TaneChat honours', async () => {
  const tool = chatTools.ALL_BY_NAME.search_chats;
  const origSearch = taneChat.searchMessages;
  const origConfigured = taneChat.isConfigured;
  let seen = null;
  taneChat.isConfigured = () => true;
  taneChat.searchMessages = async (params) => { seen = params; return { results: [] }; };
  try {
    await tool.execute({ pool: fakePool([]) },
                       { source: 'tanechat', keyword: 'deposit', since: '2026-08-01', until: '2026-08-09' });
    assert.equal(seen.from, '2026-08-01');
    assert.equal(seen.to, '2026-08-09');
    assert.equal('since' in seen, false, 'TaneChat ignores `since` — it must be sent as `from`');
  } finally {
    taneChat.searchMessages = origSearch;
    taneChat.isConfigured = origConfigured;
  }
});

/**
 * llmClient router — failover behaviour (stubbed; no real HTTP or API keys).
 * Mirrors the TaneChat failover verification: healthy primary → primary;
 * primary error → fallback; both down → throws the ORIGINAL primary error.
 */

const test = require('node:test');
const assert = require('node:assert');

// Configure the router BEFORE requiring config/llmClient (config reads env once).
process.env.AI_TEXT_PROVIDER = 'kimi';
process.env.AI_REPLY_MODEL = 'k3';
process.env.AI_TEXT_FALLBACK_PROVIDER = 'openrouter';
process.env.AI_TEXT_FALLBACK_MODEL = 'z-ai/glm-5.2';
process.env.KIMI_API_KEY = 'sk-kimi-test';
process.env.OPENROUTER_API_KEY = 'sk-or-test';

const kimi = require('../src/services/kimiClient');
const openrouter = require('../src/services/openRouterClient');
const llm = require('../src/services/llmClient');

// Silence the router's info/warn/error logging during tests.
const origLog = console.log, origWarn = console.warn, origErr = console.error;
function mute() { console.log = console.warn = console.error = () => {}; }
function unmute() { console.log = origLog; console.warn = origWarn; console.error = origErr; }

test('healthy primary → Kimi answers, via=primary', async () => {
  const origKimi = kimi.chat;
  kimi.chat = async (_m, _t, opts) => {
    assert.equal(opts.model, 'k3', 'primary should receive the reply model');
    return { message: { content: 'hi from kimi' }, finish_reason: 'stop', usage: {}, model: 'k3' };
  };
  mute();
  try {
    const r = await llm.chat([{ role: 'user', content: 'hi' }], null, {});
    assert.equal(r.provider, 'kimi');
    assert.equal(r.via, 'primary');
    assert.equal(r.message.content, 'hi from kimi');
  } finally {
    unmute();
    kimi.chat = origKimi;
  }
});

test('primary 500 → fails over to OpenRouter GLM, via=failover', async () => {
  const origKimi = kimi.chat, origOR = openrouter.chat;
  kimi.chat = async () => { const e = new Error('Kimi 500'); e.status = 500; throw e; };
  let fallbackModelSeen = null;
  openrouter.chat = async (_m, _t, opts) => {
    fallbackModelSeen = opts.model;
    return { message: { content: 'hi from glm' }, finish_reason: 'stop', usage: {}, model: opts.model };
  };
  mute();
  try {
    const r = await llm.chat([{ role: 'user', content: 'hi' }], null, {});
    assert.equal(r.provider, 'openrouter');
    assert.equal(r.via, 'failover');
    assert.equal(fallbackModelSeen, 'z-ai/glm-5.2', 'fallback should use the configured GLM model');
    assert.equal(r.message.content, 'hi from glm');
  } finally {
    unmute();
    kimi.chat = origKimi;
    openrouter.chat = origOR;
  }
});

test('both providers down → throws the ORIGINAL primary error', async () => {
  const origKimi = kimi.chat, origOR = openrouter.chat;
  kimi.chat = async () => { throw new Error('primary boom'); };
  openrouter.chat = async () => { throw new Error('fallback boom'); };
  mute();
  try {
    await assert.rejects(
      () => llm.chat([{ role: 'user', content: 'hi' }], null, {}),
      /primary boom/,
    );
  } finally {
    unmute();
    kimi.chat = origKimi;
    openrouter.chat = origOR;
  }
});

test('auth error (401) does NOT fail over — rethrows immediately', async () => {
  const origKimi = kimi.chat, origOR = openrouter.chat;
  kimi.chat = async () => { const e = new Error('bad key'); e.status = 401; throw e; };
  let fallbackCalled = false;
  openrouter.chat = async () => { fallbackCalled = true; return { message: { content: 'x' } }; };
  mute();
  try {
    await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, {}), /bad key/);
    assert.equal(fallbackCalled, false, 'must not fall over on an auth error');
  } finally {
    unmute();
    kimi.chat = origKimi;
    openrouter.chat = origOR;
  }
});

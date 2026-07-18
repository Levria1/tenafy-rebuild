/**
 * LLM router — runs the configured PRIMARY provider and, on any failure, fails
 * over per-request to the configured fallback provider.
 *
 * Default topology (see config.chat / .env):
 *   PRIMARY  = Kimi K3            (AI_TEXT_PROVIDER=kimi, AI_REPLY_MODEL=k3)
 *   FALLBACK = OpenRouter GLM-5.2 (AI_TEXT_FALLBACK_PROVIDER/MODEL)
 *   LEGACY   = MiniMax            (only if AI_TEXT_FALLBACK_MINIMAX=true and no
 *                                  generic fallback is configured)
 *
 * All three providers speak OpenAI-compatible chat-completions and return the
 * same { message, finish_reason, usage, model } shape, so messages/tools flow
 * through untouched and callers never see which provider answered.
 *
 * Failover fires on ANY primary failure (thrown error, non-2xx, timeout, or
 * empty content) EXCEPT auth/request-shape errors (400/401/403) — those signal
 * a config problem that swapping providers won't fix. If the fallback also
 * fails, the ORIGINAL primary error is re-thrown (that's the real failure).
 *
 * Model selection is entirely the router's job — callers pass only
 * messages/tools/temperature. The primary gets AI_REPLY_MODEL (or opts.model);
 * the fallback gets AI_TEXT_FALLBACK_MODEL (or opts.fallbackModel).
 */

const config = require('../config');
const kimi = require('./kimiClient');
const openrouter = require('./openRouterClient');
const minimax = require('./miniMaxClient');

const PROVIDERS = { kimi, openrouter, minimax };
const AUTH_ERRORS = new Set([400, 401, 403]);

function resolvePrimary() {
  const key = config.chat.provider || 'kimi';
  const impl = PROVIDERS[key];
  if (!impl) throw new Error(`Unknown AI_TEXT_PROVIDER '${key}' (expected kimi | openrouter | minimax)`);
  return { key, impl };
}

// Pick the fallback provider. A generic fallback (provider+model) wins; else the
// legacy MiniMax path if explicitly enabled. Never the same provider as primary.
function resolveFallback(primaryKey) {
  const fb = config.chat.fallback || {};
  if (fb.provider && PROVIDERS[fb.provider] && fb.provider !== primaryKey) {
    return { key: fb.provider, impl: PROVIDERS[fb.provider], model: fb.model || undefined };
  }
  if (!fb.provider && fb.minimax && primaryKey !== 'minimax') {
    return { key: 'minimax', impl: minimax, model: config.chat.minimax.model };
  }
  return null;
}

function shouldFallback(err, fallback) {
  if (!fallback) return false;
  // Auth/request-shape errors won't be fixed by swapping providers.
  if (err && AUTH_ERRORS.has(err.status)) return false;
  return true;
}

async function chat(messages, tools, opts = {}) {
  const primary = resolvePrimary();
  const fallback = resolveFallback(primary.key);
  const primaryModel = opts.model || config.chat.replyModel || undefined;

  try {
    const result = await primary.impl.chat(messages, tools, { ...opts, model: primaryModel });
    console.log(`LLM answered ${JSON.stringify({ provider: primary.key, model: result.model || primaryModel, via: 'primary' })}`);
    return { ...result, provider: primary.key, via: 'primary' };
  } catch (err) {
    if (!shouldFallback(err, fallback)) throw err;

    console.warn(`LLM failing over from ${primary.key} (${err.status || err.code || 'error'}): ${err.message}`);
    console.error(`LLM primary provider failed: ${primary.key}`);

    try {
      const fbModel = opts.fallbackModel || fallback.model;
      const result = await fallback.impl.chat(messages, tools, { ...opts, model: fbModel });
      console.log(`LLM answered ${JSON.stringify({ provider: fallback.key, model: result.model || fbModel, via: 'failover' })}`);
      return { ...result, provider: fallback.key, via: 'failover' };
    } catch (fallbackErr) {
      console.error(`LLM fallback (${fallback.key}) also failed: ${fallbackErr.message}`);
      // Re-throw the ORIGINAL primary error — that's the failure that matters.
      throw err;
    }
  }
}

module.exports = { chat };

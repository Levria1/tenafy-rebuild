/**
 * LLM router — tries MiniMax first, falls back to OpenRouter on hard failure.
 *
 * MiniMax's internal client already handles transient retries (529/503/network
 * errors with exponential backoff). This wrapper only takes over when MiniMax
 * exhausts its retries AND we have a fallback configured.
 *
 * Fallback is triggered when:
 *   - MiniMax throws any error after its internal retry exhausts
 *   - The error is plausibly a service issue (5xx, network, overload,
 *     rate-limit) — NOT on auth errors (400/401/403), since those indicate
 *     config problems that won't be solved by swapping providers.
 *   - `LLM_FALLBACK_ENABLED=true` in env AND OPENROUTER_API_KEY is set.
 *
 * If the fallback also fails, the MiniMax error is re-thrown (since that was
 * the "real" primary failure the user cares about).
 *
 * Both providers speak OpenAI-compatible chat-completions, so the messages
 * and tools arrays flow through untouched. Response shape is identical.
 */

const config = require('../config');
const minimax = require('./miniMaxClient');
const openrouter = require('./openRouterClient');

const AUTH_ERRORS = new Set([400, 401, 403]);

function shouldFallback(err) {
  if (!config.chat.fallbackEnabled) return false;
  if (!config.chat.openrouter.apiKey) return false;
  // Don't fallback on auth/request-shape errors — those won't be fixed by
  // swapping providers and would just burn fallback quota on a bug.
  if (err && AUTH_ERRORS.has(err.status)) return false;
  return true;
}

async function chat(messages, tools, opts = {}) {
  try {
    const result = await minimax.chat(messages, tools, opts);
    return { ...result, provider: 'minimax' };
  } catch (err) {
    if (!shouldFallback(err)) throw err;

    console.warn(
      `[llmClient] MiniMax failed (${err.status || err.code || 'error'}): ${err.message}. ` +
      `Falling back to OpenRouter (${config.chat.openrouter.model}).`
    );

    try {
      const result = await openrouter.chat(messages, tools, opts);
      return { ...result, provider: 'openrouter' };
    } catch (fallbackErr) {
      console.error(`[llmClient] OpenRouter fallback also failed: ${fallbackErr.message}`);
      // Re-throw the ORIGINAL error — that's what the user/staff actually
      // need to see. Fallback failure is just noise on top.
      throw err;
    }
  }
}

module.exports = { chat };

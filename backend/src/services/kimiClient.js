/**
 * Kimi Code chat-completions client (PRIMARY LLM).
 *
 * IMPORTANT: this targets **Kimi Code** (kimi.com/code) — a coding subscription,
 * NOT the Moonshot Platform. The official Moonshot hosts (api.moonshot.ai /
 * api.moonshot.cn) REJECT the Kimi Code key with 401. Key prefix is `sk-kimi-…`.
 *
 * Endpoint: POST https://api.kimi.com/coding/v1/chat/completions  (OpenAI-compatible)
 * Auth:     Authorization: Bearer <KIMI_API_KEY>
 *
 * Model `k3` is a REASONING model: the response message carries both `content`
 * (the answer) and `reasoning_content` (the thinking). We read `content` and
 * strip `reasoning_content` before returning so it doesn't pollute the history
 * we replay to the model on later tool-loop turns.
 *
 * Notes:
 *   - `reasoning_effort: low` (K3 default is `max`) conserves the coding-plan
 *     quota. The OpenRouter-style `reasoning:{enabled:false}` is IGNORED by Kimi.
 *   - `max_tokens` is kept generous (default 12288). Too low and reasoning eats
 *     the whole budget → empty `content` → we treat that as an error → failover.
 *   - Single attempt with a fail-fast timeout: on ANY failure the router fails
 *     over to OpenRouter GLM, which beats retrying a hung/quota-exhausted primary.
 *
 * Returns the same { message, finish_reason, usage, model } shape as the other
 * providers so llmClient can treat them interchangeably.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('../config');

function postJson(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const err = new Error(`Kimi ${res.statusCode}: ${raw.slice(0, 500)}`);
              err.status = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Kimi non-JSON response: ${raw.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    // Fail-fast so a hung primary fails over instead of stalling the request.
    req.setTimeout(timeoutMs || 60000, () => {
      req.destroy(Object.assign(new Error('Kimi request timeout'), { code: 'ETIMEDOUT' }));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * One round-trip to Kimi Code.
 * @param {Array}  messages  OpenAI-style messages array
 * @param {Array}  tools     Function-calling tool definitions (optional)
 * @param {object} opts      { temperature?, model?, toolChoice? }
 * @returns {Promise<{ message, finish_reason, usage, model }>}
 */
async function chat(messages, tools, opts = {}) {
  const cfg = config.chat.kimi || {};
  if (!cfg.apiKey) {
    throw new Error('KIMI_API_KEY not configured');
  }

  const base = (cfg.baseUrl || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const model = opts.model || 'k3';

  const body = {
    model,
    messages,
    // K3 is a reasoning model and ONLY accepts temperature=1 — any other value
    // (e.g. a caller's 0/0.1 for "deterministic" extraction) returns a hard 400.
    // Its determinism comes from the reasoning pass, not the sampling temp, so we
    // pin 1 regardless of what the caller asked for.
    temperature: 1,
    max_tokens: cfg.maxTokens || 12288,
    reasoning_effort: cfg.reasoningEffort || 'low',
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = opts.toolChoice || 'auto';
  }

  const headers = { Authorization: `Bearer ${cfg.apiKey}` };

  const resp = await postJson(url, headers, body, config.chat.timeoutMs);

  if (resp.error) {
    const err = new Error(`Kimi error: ${resp.error.message || JSON.stringify(resp.error)}`);
    err.body = resp;
    throw err;
  }

  const choice = resp.choices && resp.choices[0];
  if (!choice) throw new Error('Kimi returned no choices');

  const message = choice.message || {};
  // Strip the reasoning trace — we only want the answer + any tool calls in the
  // history we replay to the model later (and to keep it portable if a fallback
  // provider serves the next turn).
  if ('reasoning_content' in message) delete message.reasoning_content;

  // Empty content with NO tool calls means the model produced nothing usable
  // (commonly: reasoning consumed the whole token budget). Treat it as a service
  // error so the router fails over. A blank content WITH tool_calls is a normal,
  // valid turn and must NOT be treated as an error.
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
  if (!hasContent && !hasTools) {
    const err = new Error('Kimi returned empty content');
    err.status = 502; // service issue → eligible for failover (not an auth error)
    throw err;
  }

  return {
    message,
    finish_reason: choice.finish_reason,
    usage: resp.usage || {},
    model,
  };
}

module.exports = { chat };

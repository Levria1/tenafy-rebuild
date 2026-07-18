/**
 * OpenRouter chat-completions client (fallback LLM).
 *
 * OpenRouter proxies many providers (Anthropic, OpenAI, Mistral, Llama, Gemini,
 * etc.) behind a single OpenAI-compatible API. We use it as a fallback when
 * MiniMax fails hard — the request/response shape matches OpenAI's
 * /chat/completions exactly, including tool_calls, so no message translation
 * is needed.
 *
 * Docs: https://openrouter.ai/docs
 * Endpoint: POST https://openrouter.ai/api/v1/chat/completions
 *
 * Required env vars:
 *   OPENROUTER_API_KEY    - sk-or-v1-... (from https://openrouter.ai/keys)
 *   OPENROUTER_MODEL      - e.g. "anthropic/claude-3.5-sonnet"
 *                                "openai/gpt-4o-mini"
 *                                "google/gemini-2.0-flash-exp:free"
 *
 * Optional:
 *   OPENROUTER_BASE_URL   - defaults to https://openrouter.ai/api/v1
 *   APP_URL               - sent as HTTP-Referer (helps OpenRouter rank your
 *                           app; also required by some rate-limit tiers)
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
              const err = new Error(`OpenRouter ${res.statusCode}: ${raw.slice(0, 500)}`);
              err.status = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`OpenRouter non-JSON response: ${raw.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || 60000, () => {
      req.destroy(Object.assign(new Error('OpenRouter request timeout'), { code: 'ETIMEDOUT' }));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * One round-trip to OpenRouter.
 * Returns the same { message, usage, finish_reason } shape as miniMaxClient.chat.
 */
async function chat(messages, tools, opts = {}) {
  const cfg = config.chat.openrouter || {};
  if (!cfg.apiKey) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const base = (cfg.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const url  = base + '/chat/completions';

  // If neither opts.model nor cfg.model is set, OMIT the model field entirely.
  // OpenRouter will then use whatever default is configured on the account /
  // API key (or `openrouter/auto` if nothing is pinned). This lets you change
  // models from the OpenRouter dashboard without redeploying.
  const body = {
    messages,
    temperature: opts.temperature ?? 0.3,
    stream: false,
    // GLM (and other reasoning models) otherwise put the answer in a separate
    // reasoning field; disabling reasoning makes it land in `content` where our
    // parser reads it. Harmless for non-reasoning models (OpenRouter ignores it).
    reasoning: { enabled: false },
  };
  const modelChoice = opts.model || cfg.model;
  if (modelChoice) body.model = modelChoice;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = opts.toolChoice || 'auto';
  }

  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    // OpenRouter uses these for rate-limit tiers and dashboard attribution.
    // Not strictly required but strongly recommended per their docs.
    'HTTP-Referer': config.appUrl || 'http://localhost:3000',
    'X-Title': 'Tenafy',
  };

  const resp = await postJson(url, headers, body, config.chat.timeoutMs);

  if (resp.error) {
    const err = new Error(`OpenRouter error: ${resp.error.message || JSON.stringify(resp.error)}`);
    err.body = resp;
    throw err;
  }

  const choice = resp.choices && resp.choices[0];
  if (!choice) throw new Error('OpenRouter returned no choices');

  const message = choice.message || {};
  if ('reasoning_content' in message) delete message.reasoning_content;

  // Empty content with no tool calls = nothing usable; treat as a service error.
  // (A blank content WITH tool_calls is a normal tool-calling turn — not an error.)
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
  if (!hasContent && !hasTools) {
    const err = new Error('OpenRouter returned empty content');
    err.status = 502;
    throw err;
  }

  return {
    message,
    finish_reason: choice.finish_reason,
    usage: resp.usage || {},
    model: modelChoice,
  };
}

module.exports = { chat };

/**
 * Thin MiniMax chat-completions client.
 *
 * MiniMax exposes an OpenAI-compatible `/text/chatcompletion_v2` endpoint.
 * Request shape is very close to OpenAI's `/chat/completions`:
 *   { model, messages: [...], tools: [...], tool_choice, temperature, ... }
 *
 * Response choices[0].message may contain:
 *   - `content`: final assistant text, OR
 *   - `tool_calls`: [{ id, type: 'function', function: { name, arguments } }]
 *
 * This module does a SINGLE call. The multi-turn tool-call loop lives in
 * routes/chat.js so it can write intermediate tool results into chat_message
 * and enforce per-session guardrails between iterations.
 *
 * Keep this file provider-thin — if we swap in Anthropic/OpenAI later, only
 * the request/response shape needs to change.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('../config');

function postJson(urlStr, headers, body) {
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
              const err = new Error(`MiniMax ${res.statusCode}: ${raw.slice(0, 500)}`);
              err.status = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`MiniMax non-JSON response: ${raw.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('MiniMax request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Retryable errors (transient server-side / network issues).
// 529 = MiniMax "overloaded"; 502/503/504 = gateway / upstream issues;
// ETIMEDOUT/ECONNRESET = network blip.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 529]);
const RETRYABLE_CODES  = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);
const MAX_ATTEMPTS     = 4;          // total attempts (initial + 3 retries)
const BACKOFF_MS       = [1000, 3000, 6000]; // delays between attempts 1->2, 2->3, 3->4

function isRetryable(err) {
  if (err && RETRYABLE_STATUS.has(err.status)) return true;
  if (err && err.code && RETRYABLE_CODES.has(err.code)) return true;
  // MiniMax returns the 529 as an HTTP error from postJson; also check body
  if (err && err.body && err.body.error && err.body.error.type === 'overloaded_error') return true;
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * One round-trip to MiniMax with retry-on-overload.
 *
 * Retries up to 3 times with exponential backoff (1s, 3s, 6s) on transient
 * errors like 529 overloaded, 503/504 gateway issues, or network blips.
 * Non-retryable errors (auth, malformed request, real 4xx) bubble up immediately.
 *
 * @param {Array}  messages  OpenAI-style messages array (role+content, plus tool_calls / tool responses)
 * @param {Array}  tools     Function-calling tool definitions
 * @param {object} opts      { temperature?, model?, toolChoice? }
 * @returns {Promise<{ message, usage, finish_reason }>}
 */
async function chat(messages, tools, opts = {}) {
  const cfg = config.chat.minimax;
  if (!cfg.apiKey) {
    throw new Error('MINIMAX_API_KEY not configured');
  }

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/text/chatcompletion_v2';
  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.3,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = opts.toolChoice || 'auto';
  }

  const headers = { Authorization: `Bearer ${cfg.apiKey}` };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await postJson(url, headers, body);

      // MiniMax wraps success info under `base_resp`; bubble up useful failures.
      if (resp.base_resp && resp.base_resp.status_code && resp.base_resp.status_code !== 0) {
        const err = new Error(`MiniMax error ${resp.base_resp.status_code}: ${resp.base_resp.status_msg}`);
        err.body = resp;
        // status_code 1040/1041 are MiniMax's rate-limit codes — also retry
        if ([1040, 1041].includes(resp.base_resp.status_code)) err.status = 429;
        throw err;
      }

      const choice = resp.choices && resp.choices[0];
      if (!choice) throw new Error('MiniMax returned no choices');

      return {
        message: choice.message || {},
        finish_reason: choice.finish_reason,
        usage: resp.usage || {},
      };
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      const hasMore = attempt < MAX_ATTEMPTS;
      if (retryable && hasMore) {
        const waitMs = BACKOFF_MS[attempt - 1] || 6000;
        console.warn(`[miniMaxClient] attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.status || err.code || 'unknown'}) — retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = { chat };

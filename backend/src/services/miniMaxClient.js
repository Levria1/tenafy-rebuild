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

/**
 * One round-trip to MiniMax.
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
  const resp = await postJson(url, headers, body);

  // MiniMax wraps success info under `base_resp`; bubble up useful failures.
  if (resp.base_resp && resp.base_resp.status_code && resp.base_resp.status_code !== 0) {
    const err = new Error(`MiniMax error ${resp.base_resp.status_code}: ${resp.base_resp.status_msg}`);
    err.body = resp;
    throw err;
  }

  const choice = resp.choices && resp.choices[0];
  if (!choice) throw new Error('MiniMax returned no choices');

  return {
    message: choice.message || {},
    finish_reason: choice.finish_reason,
    usage: resp.usage || {},
  };
}

module.exports = { chat };

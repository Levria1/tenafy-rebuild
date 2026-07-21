/**
 * TaneChat integration client (WhatsApp/email message search).
 *
 * TaneChat is Tenafy's sister product and owns the live WhatsApp/email history.
 * This read-only server-to-server client exposes the integration search API to
 * Chat: Internal so staff can reconcile bank lines against actual messages.
 *
 * Endpoint:
 *   GET https://chat.taneresidence.com/api/integration/search/messages
 *   GET https://chat.taneresidence.com/api/integration/conversations/:id/messages
 *
 * Required env vars:
 *   TANECHAT_API_KEY      - integration API key
 *
 * Optional:
 *   TANECHAT_API_URL      - defaults to https://chat.taneresidence.com/api/integration
 *   TANECHAT_TIMEOUT_MS   - defaults to 10000
 */

const https = require('https');
const http = require('http');
const { URL, URLSearchParams } = require('url');
const config = require('../config');

function isConfigured() {
  return !!((config.chat.taneChat || {}).apiKey || '').trim();
}

function cleanParams(params = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (key === 'limit') {
      const parsed = parseInt(value);
      if (Number.isFinite(parsed) && parsed > 0) out.set(key, String(Math.min(parsed, 100)));
      continue;
    }
    out.set(key, String(value));
  }
  return out;
}

function getJson(pathname, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cfg = config.chat.taneChat || {};
    const base = (cfg.baseUrl || 'https://chat.taneresidence.com/api/integration').replace(/\/+$/, '');
    const query = cleanParams(params).toString();
    const urlStr = base + pathname + (query ? `?${query}` : '');
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'X-API-Key': cfg.apiKey,
          Accept: 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (e) {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const err = new Error(`TaneChat ${res.statusCode}: ${raw.slice(0, 500)}`);
              err.status = res.statusCode;
              return reject(err);
            }
            return reject(new Error(`TaneChat non-JSON response: ${raw.slice(0, 500)}`));
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = parsed && parsed.error ? parsed.error : raw.slice(0, 500);
            const err = new Error(`TaneChat ${res.statusCode}: ${msg}`);
            err.status = res.statusCode;
            err.body = parsed;
            if (res.statusCode === 429 && res.headers && res.headers['retry-after']) {
              const retryAfter = parseInt(res.headers['retry-after']);
              if (Number.isFinite(retryAfter)) err.retryAfterSeconds = retryAfter;
            }
            return reject(err);
          }

          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || 10000, () => {
      req.destroy(Object.assign(new Error('TaneChat request timeout'), { code: 'ETIMEDOUT' }));
    });
    req.end();
  });
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error('TANECHAT_API_KEY not configured');
  }
}

async function searchMessages(params = {}) {
  assertConfigured();
  const cfg = config.chat.taneChat || {};
  return getJson('/search/messages', params, cfg.timeoutMs);
}

async function getConversationMessages(conversationId, opts = {}) {
  assertConfigured();
  if (!conversationId) throw new Error('conversationId is required');
  const cfg = config.chat.taneChat || {};
  const id = encodeURIComponent(String(conversationId));
  return getJson(`/conversations/${id}/messages`, { around: opts.around, limit: opts.limit }, cfg.timeoutMs);
}

module.exports = {
  isConfigured,
  searchMessages,
  getConversationMessages,
};

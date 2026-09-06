const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { resolveExtractMode } = require('../utils/inquiryFacts');

module.exports = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'tenafy-secret-key-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  // Tenant portal tokens are signed with their OWN secret so a tenant token cannot
  // verify against the 412 staff endpoints behind `authenticate`. No default and no
  // fallback to jwtSecret on purpose: either is the hole this exists to close, and
  // utils/tenantPortalTokens.js refuses to sign without it. Unset simply means the
  // tenant portal is off, which is the correct fail-closed state.
  tenantJwtSecret: process.env.TENANT_JWT_SECRET || '',
  tenantJwtExpiresIn: process.env.TENANT_JWT_EXPIRES_IN || '2h',
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tenafy',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },
  // SELECT-only MySQL credentials used ONLY by the internal assistant's ask_data
  // (NL->SQL) tool. This is the DB-level half of the read-only guarantee: even if
  // the app-side SQL guard were bypassed, the grant makes writes physically fail.
  // Leave DB_RO_USER unset to disable ask_data cleanly (the tool reports it's
  // not configured rather than falling back to the read-write pool).
  dbReadOnly: {
    user: process.env.DB_RO_USER || '',
    password: process.env.DB_RO_PASSWORD || '',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  appUrl: process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
  // Sender for account and security email: password resets, activation codes, portal
  // registration links. Kept apart from EMAIL_FROM because that one is a billing
  // address, and a credential link arriving from the address that asks people for
  // money teaches exactly the habit phishing relies on.
  //
  // Empty means "no separate sender configured", and every one of those emails falls
  // back to EMAIL_FROM as before. Deliberately not defaulted to a literal address:
  // this is a multi-tenant product and no address belongs in the source.
  emailFromAccount: process.env.EMAIL_FROM_ACCOUNT || '',
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '',
  // Parallel-run mode for the TaneChat cutover. 'notes' (default) = the nightly
  // inquiry re-extraction appends to inquiry.notes as it always has. 'staging' =
  // it writes to inquiry_fact_staging instead, so TaneChat's facts and ours can be
  // compared for sign-off without both writing to the same append-only field.
  inquiryExtractMode: resolveExtractMode(process.env.INQUIRY_EXTRACT_MODE),
  chat: {
    enabled: process.env.CHAT_ENABLED !== 'false', // default on; set CHAT_ENABLED=false to globally disable
    maxToolIterations: parseInt(process.env.CHAT_MAX_TOOL_ITERATIONS || '6'),

    // Primary text-LLM provider + model. Env names match the TaneChat failover
    // spec so both products share one mental model.
    //   AI_TEXT_PROVIDER: kimi | openrouter | minimax   (default kimi)
    //   AI_REPLY_MODEL:   model id sent to the primary   (default k3 for Kimi)
    provider:   process.env.AI_TEXT_PROVIDER || 'kimi',
    replyModel: process.env.AI_REPLY_MODEL || 'k3',
    // Reserved: point the classifier/extraction calls at a cheaper model without
    // touching the reply model. Empty => use replyModel.
    classifierModel: process.env.AI_CLASSIFIER_MODEL || '',
    // Fail-fast timeout (ms) so a hung primary fails over instead of stalling.
    timeoutMs: parseInt(process.env.AI_TEXT_TIMEOUT_MS || '60000'),

    // Automatic per-request failover. Active when a fallback provider+model is
    // configured (and differs from the primary). Auth errors never fail over.
    fallback: {
      provider: process.env.AI_TEXT_FALLBACK_PROVIDER || '', // e.g. openrouter
      model:    process.env.AI_TEXT_FALLBACK_MODEL || '',    // e.g. z-ai/glm-5.2
      // Legacy MiniMax fallback — only used if true AND no generic fallback set.
      minimax:  process.env.AI_TEXT_FALLBACK_MINIMAX === 'true',
    },

    // ── Connectors ──────────────────────────────────────────────────────────
    // Kimi Code (kimi.com/code) — a coding SUBSCRIPTION, NOT Moonshot Platform.
    // Base is api.kimi.com/coding/v1; key prefix sk-kimi-…; the Moonshot hosts
    // reject this key with 401. K3 is a reasoning model — reasoning_effort:low
    // conserves quota; keep max_tokens generous so reasoning doesn't eat the
    // whole budget and leave empty content.
    kimi: {
      apiKey:  process.env.KIMI_API_KEY  || '',
      baseUrl: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1',
      reasoningEffort: process.env.KIMI_REASONING_EFFORT || 'low', // low | high | max
      maxTokens: parseInt(process.env.KIMI_MAX_TOKENS || '12288'),
    },
    openrouter: {
      apiKey:  process.env.OPENROUTER_API_KEY  || '',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      // Usually supplied by the router (AI_REPLY_MODEL when primary, or
      // AI_TEXT_FALLBACK_MODEL when fallback). This is only the last-resort
      // default if neither is passed.
      model:   process.env.OPENROUTER_MODEL    || '',
    },
    taneChat: {
      baseUrl: process.env.TANECHAT_API_URL || 'https://chat.taneresidence.com/api/integration',
      apiKey:  process.env.TANECHAT_API_KEY || '',
      timeoutMs: parseInt(process.env.TANECHAT_TIMEOUT_MS || '10000'),
    },
    minimax: {
      apiKey:  process.env.MINIMAX_API_KEY  || '',
      groupId: process.env.MINIMAX_GROUP_ID || '',
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.chat/v1',
      model:   process.env.MINIMAX_MODEL    || 'MiniMax-Text-01',
    },
  },
};

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'tenafy-secret-key-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
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
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  appUrl: process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '',
  chat: {
    enabled: process.env.CHAT_ENABLED !== 'false', // default on; set CHAT_ENABLED=false to globally disable
    provider: process.env.LLM_PROVIDER || 'minimax',
    maxToolIterations: parseInt(process.env.CHAT_MAX_TOOL_ITERATIONS || '6'),
    // When true, llmClient falls back to OpenRouter if MiniMax fails after its
    // own retries. Requires OPENROUTER_API_KEY to actually do anything.
    fallbackEnabled: process.env.LLM_FALLBACK_ENABLED === 'true',
    minimax: {
      apiKey:  process.env.MINIMAX_API_KEY  || '',
      groupId: process.env.MINIMAX_GROUP_ID || '',
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.chat/v1',
      model:   process.env.MINIMAX_MODEL    || 'MiniMax-Text-01',
    },
    openrouter: {
      apiKey:  process.env.OPENROUTER_API_KEY  || '',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      // Leave blank to let OpenRouter use your account/API-key default model.
      // Or set explicitly (e.g. 'openai/gpt-4o-mini', 'openrouter/auto').
      model:   process.env.OPENROUTER_MODEL    || '',
    },
  },
};
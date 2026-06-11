/**
 * Xero OAuth2 + API client.
 *
 * Responsibilities:
 *   - Build the OAuth2 consent URL for the Connect Xero button
 *   - Exchange a callback `code` for access + refresh tokens
 *   - Auto-refresh the access token when it's near expiry
 *   - Make API calls scoped to a Tenafy org's stored connection
 *   - Encrypt tokens at rest using AES-256-GCM
 *
 * Tokens are stored in `xero_connection` (per-org). Each Tenafy org has at
 * most ONE Xero connection. Multi-Xero-org per Tenafy-org is out of scope.
 *
 * Env required (set in backend/.env):
 *   XERO_CLIENT_ID
 *   XERO_CLIENT_SECRET
 *   XERO_REDIRECT_URI                   (e.g. https://platform.tenafy.com/api/integrations/xero/callback)
 *   XERO_TOKEN_ENCRYPTION_KEY           (any 32+ random bytes, base64 or hex)
 *
 * Xero API docs: https://developer.xero.com/documentation/guides/oauth2/auth-flow/
 */

const crypto = require('crypto');
const axios  = require('axios');

const XERO_OAUTH_AUTH_URL   = 'https://login.xero.com/identity/connect/authorize';
const XERO_OAUTH_TOKEN_URL  = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL  = 'https://api.xero.com/connections';
const XERO_API_BASE         = 'https://api.xero.com/api.xro/2.0';
const REFRESH_LEEWAY_SECONDS = 60; // refresh when <60s remaining on access_token

const SCOPES = [
  'offline_access',                          // required for refresh_token
  'accounting.banktransactions.read',        // bank transactions
  'accounting.contacts.read',                // payer name → tenant matching
  'accounting.settings.read',                // chart of accounts (bank accounts list)
  'accounting.reports.banksummary.read',     // BankSummary report → per-account closing balance
];

// ───────────────────────────────────────────────────────────────────────────
// Encryption helpers (AES-256-GCM)
//
// Token-at-rest model: derive a 32-byte AES key from XERO_TOKEN_ENCRYPTION_KEY
// (env). Ciphertext format stored in DB: base64( iv(12) | tag(16) | cipher ).
// Compromise of the DB alone doesn't reveal tokens; compromise of the env
// secret + DB does. Good enough for our risk model.
// ───────────────────────────────────────────────────────────────────────────

function _getKey() {
  const raw = process.env.XERO_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('XERO_TOKEN_ENCRYPTION_KEY not set in env');
  }
  // Accept hex, base64, or arbitrary string — derive 32 bytes via SHA-256
  // so we don't care about the input format.
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = _getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(ciphertext) {
  if (ciphertext == null) return null;
  const key = _getKey();
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < 28) throw new Error('Xero token ciphertext too short');
  const iv  = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const enc = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ───────────────────────────────────────────────────────────────────────────
// OAuth flow primitives
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the URL we redirect the user to so they consent on Xero's domain.
 * `state` is an opaque value we generate per-attempt and verify on callback
 * to defend against CSRF.
 */
function getAuthUrl(state) {
  const clientId    = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error('XERO_CLIENT_ID or XERO_REDIRECT_URI not set in env');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state: state,
  });
  return `${XERO_OAUTH_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the `code` returned by Xero (after user consent) for tokens.
 * Returns { access_token, refresh_token, expires_in, scope }.
 */
async function exchangeCodeForTokens(code) {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri  = process.env.XERO_REDIRECT_URI;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri,
  });
  const r = await axios.post(XERO_OAUTH_TOKEN_URL, body.toString(), {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
  });
  return r.data; // { access_token, refresh_token, expires_in, token_type, scope }
}

/**
 * Refresh an expired (or near-expired) access token using the refresh_token.
 * Xero rotates the refresh_token on every refresh — the response contains a
 * NEW refresh_token that must be stored. Old refresh_tokens become invalid.
 */
async function refreshTokens(refreshToken) {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const r = await axios.post(XERO_OAUTH_TOKEN_URL, body.toString(), {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
  });
  return r.data;
}

/**
 * Discover which Xero org(s) the user authorized. Returns an array; we
 * persist the first (and typically only) one. Required after the initial
 * code-exchange because the access_token alone doesn't tell us which Xero
 * org it's for — Xero exposes that via the /connections endpoint.
 */
async function listConnections(accessToken) {
  const r = await axios.get(XERO_CONNECTIONS_URL, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  return r.data; // [{ id, tenantId, tenantType, tenantName, createdDateUtc, updatedDateUtc }]
}

// ───────────────────────────────────────────────────────────────────────────
// Connection persistence
// ───────────────────────────────────────────────────────────────────────────

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

async function getConnection(pool, orgId) {
  const [[row]] = await pool.execute(
    'SELECT * FROM xero_connection WHERE org_id = ? LIMIT 1',
    [orgId]
  );
  return row || null;
}

async function saveConnection(pool, orgId, {
  xero_tenant_id, xero_tenant_name, access_token, refresh_token, expires_in, scope,
}) {
  const expiresAt = new Date(Date.now() + (Number(expires_in) - REFRESH_LEEWAY_SECONDS) * 1000);
  // expires_in is the access_token lifetime (typically 1800s = 30 min). We
  // shave a leeway off so we proactively refresh before Xero rejects calls.
  const existing = await getConnection(pool, orgId);
  if (existing) {
    await pool.execute(
      `UPDATE xero_connection
          SET xero_tenant_id = ?, xero_tenant_name = ?,
              access_token_enc = ?, refresh_token_enc = ?,
              expires_at = ?, scopes = ?
        WHERE id = ?`,
      [
        xero_tenant_id, xero_tenant_name,
        encrypt(access_token), encrypt(refresh_token),
        expiresAt, scope || null,
        existing.id,
      ]
    );
    return existing.id;
  }
  const id = newId();
  await pool.execute(
    `INSERT INTO xero_connection
        (id, org_id, xero_tenant_id, xero_tenant_name,
         access_token_enc, refresh_token_enc, expires_at, scopes,
         connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      id, orgId, xero_tenant_id, xero_tenant_name,
      encrypt(access_token), encrypt(refresh_token),
      expiresAt, scope || null,
    ]
  );
  return id;
}

async function deleteConnection(pool, orgId) {
  await pool.execute('DELETE FROM xero_connection WHERE org_id = ?', [orgId]);
}

/**
 * Return a valid access_token for the org, refreshing first if expired.
 * Persists the new tokens before returning. Throws if no connection exists.
 */
async function getValidAccessToken(pool, orgId) {
  const conn = await getConnection(pool, orgId);
  if (!conn) throw new Error('No Xero connection for this org');

  // Still valid? — return as-is.
  if (new Date(conn.expires_at).getTime() > Date.now()) {
    return { accessToken: decrypt(conn.access_token_enc), xeroTenantId: conn.xero_tenant_id };
  }

  // Refresh. Xero rotates refresh_token — must persist new one.
  const refreshToken = decrypt(conn.refresh_token_enc);
  let fresh;
  try {
    fresh = await refreshTokens(refreshToken);
  } catch (err) {
    // Mark connection broken so UI can prompt re-connect, then rethrow.
    await pool.execute(
      `UPDATE xero_connection SET last_sync_status = 'error',
              last_sync_message = ? WHERE id = ?`,
      [`Refresh failed: ${err.message}`, conn.id]
    );
    throw new Error('Xero refresh failed; please reconnect: ' + err.message);
  }
  const expiresAt = new Date(Date.now() + (Number(fresh.expires_in) - REFRESH_LEEWAY_SECONDS) * 1000);
  await pool.execute(
    `UPDATE xero_connection
        SET access_token_enc = ?, refresh_token_enc = ?,
            expires_at = ?, scopes = ?
      WHERE id = ?`,
    [
      encrypt(fresh.access_token), encrypt(fresh.refresh_token),
      expiresAt, fresh.scope || conn.scopes,
      conn.id,
    ]
  );
  return { accessToken: fresh.access_token, xeroTenantId: conn.xero_tenant_id };
}

// ───────────────────────────────────────────────────────────────────────────
// Authenticated Xero API call
// ───────────────────────────────────────────────────────────────────────────

/**
 * Make an authenticated GET against the Xero accounting API for an org.
 * Auto-refreshes tokens. Returns parsed response data.
 *
 * Example:
 *   await xeroApiGet(pool, orgId, '/BankTransactions', {
 *     where: 'Date >= DateTime(2026,06,01)',
 *     page: 1,
 *   });
 */
async function xeroApiGet(pool, orgId, path, params = {}) {
  const { accessToken, xeroTenantId } = await getValidAccessToken(pool, orgId);
  const url = XERO_API_BASE + path;
  const r = await axios.get(url, {
    params,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': xeroTenantId,
      'Accept': 'application/json',
    },
  });
  return r.data;
}

module.exports = {
  // OAuth primitives
  getAuthUrl,
  exchangeCodeForTokens,
  refreshTokens,
  listConnections,
  // Persistence
  getConnection,
  saveConnection,
  deleteConnection,
  getValidAccessToken,
  // API
  xeroApiGet,
  // Crypto (exposed for testing)
  _encrypt: encrypt,
  _decrypt: decrypt,
};

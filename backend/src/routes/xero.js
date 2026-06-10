/**
 * Xero integration routes.
 *
 * Mounted at: /api/integrations/xero
 *
 * Flow:
 *   1. User clicks "Connect Xero" in Tenafy.
 *      → frontend hits GET /connect (this file)
 *      → we 302 to Xero's consent screen with a CSRF `state` cookie
 *
 *   2. User consents on Xero; Xero 302s back to GET /callback?code=...&state=...
 *      → we verify state, exchange code for tokens, fetch the Xero tenant id,
 *        persist to xero_connection
 *      → we 302 to /settings/integrations?connected=1 (front-end shows success)
 *
 *   3. UI calls GET /status whenever it needs to render the integration card.
 *
 *   4. UI calls POST /disconnect to wipe the saved tokens (does NOT revoke
 *      on Xero's side — user can revoke from their Xero "Connected Apps"
 *      settings if they want a full kill).
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const xeroClient = require('../services/xeroClient');
const xeroSync = require('../services/xeroSync');

// Short-lived CSRF state cookie. Encoded as {orgId}.{random}.{hmac} so the
// callback (which runs in the SAME browser tab as /connect) can recover the
// org without trusting the URL or relying on a session lookup.
const STATE_COOKIE = '__xero_oauth_state';
const STATE_TTL_SECONDS = 600; // 10 minutes — generous; OAuth consent is usually <30s

function _stateSecret() {
  const s = process.env.XERO_TOKEN_ENCRYPTION_KEY;
  if (!s) throw new Error('XERO_TOKEN_ENCRYPTION_KEY not set');
  return crypto.createHash('sha256').update(s + '::state').digest();
}

function _signState(orgId) {
  const rand = crypto.randomBytes(16).toString('hex');
  const payload = `${orgId}.${rand}.${Date.now()}`;
  const hmac = crypto.createHmac('sha256', _stateSecret()).update(payload).digest('hex').slice(0, 16);
  return `${payload}.${hmac}`;
}

function _verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [orgId, rand, ts, hmac] = parts;
  const payload = `${orgId}.${rand}.${ts}`;
  const expected = crypto.createHmac('sha256', _stateSecret()).update(payload).digest('hex').slice(0, 16);
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
  if (Date.now() - Number(ts) > STATE_TTL_SECONDS * 1000) return null;
  return orgId;
}

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, msg, s = 500) { return res.status(s).json({ code: s, message: msg }); }

// ───────────────────────────────────────────────────────────────────────────
// GET /connect
// Authenticated. Builds Xero consent URL with CSRF state, 302s the browser
// to Xero. The browser arrives at Xero with the auth code after consent.
// ───────────────────────────────────────────────────────────────────────────
router.get('/connect', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const state = _signState(orgId);
    // Cookie isn't strictly required since state itself is signed + carries
    // orgId, but we set it as an extra binding so a stolen state value alone
    // can't be replayed in a different browser session.
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: STATE_TTL_SECONDS * 1000,
      secure: process.env.NODE_ENV === 'production',
    });
    return res.redirect(xeroClient.getAuthUrl(state));
  } catch (err) {
    console.error('[xero/connect] error:', err);
    return fail(res, err.message || 'Failed to start Xero connect', 500);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /callback?code=...&state=...
// Xero redirects here after consent. We verify state, exchange code, persist
// tokens, and redirect to the Tenafy settings page.
//
// Note: NOT gated by `authenticate` middleware because the user is mid-OAuth
// (Xero just bounced them back) and the only thing tying it to the user is
// the signed state + cookie. We re-establish trust via the signed orgId.
// ───────────────────────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      return res.redirect(`/settings/integrations?xero_error=${encodeURIComponent(String(oauthError))}`);
    }
    const orgId = _verifyState(state);
    if (!orgId) {
      return res.redirect('/settings/integrations?xero_error=invalid_state');
    }
    // Cookie binding check — defends against stolen-state replay across browsers.
    const cookieState = req.cookies?.[STATE_COOKIE];
    if (cookieState && cookieState !== state) {
      return res.redirect('/settings/integrations?xero_error=state_mismatch');
    }
    res.clearCookie(STATE_COOKIE);

    if (!code) {
      return res.redirect('/settings/integrations?xero_error=missing_code');
    }

    // Exchange code → tokens.
    const tokens = await xeroClient.exchangeCodeForTokens(String(code));

    // Discover which Xero org the user authorized. Pick the first (most users
    // have exactly one); multi-tenant Xero-orgs-per-Tenafy-org is out of scope.
    const connections = await xeroClient.listConnections(tokens.access_token);
    if (!connections || connections.length === 0) {
      return res.redirect('/settings/integrations?xero_error=no_connections');
    }
    const xeroTenant = connections[0];

    // Persist. The pool for this org is on req.pool — but since this route
    // isn't authenticated via the normal middleware, we need to grab the
    // org's pool manually. We use the same poolRegistry pattern other code
    // uses for cross-cutting jobs.
    const { getOrgPool } = require('../config/poolRegistry');
    const pool = await getOrgPool(orgId);

    await xeroClient.saveConnection(pool, orgId, {
      xero_tenant_id:   xeroTenant.tenantId,
      xero_tenant_name: xeroTenant.tenantName,
      access_token:     tokens.access_token,
      refresh_token:    tokens.refresh_token,
      expires_in:       tokens.expires_in,
      scope:            tokens.scope,
    });

    return res.redirect('/settings/integrations?xero_connected=1');
  } catch (err) {
    console.error('[xero/callback] error:', err);
    const msg = encodeURIComponent(err.response?.data?.error_description || err.message || 'unknown');
    return res.redirect(`/settings/integrations?xero_error=${msg}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /status
// Quick check: is Xero connected for this org? Returns the bare minimum
// the settings page needs to render — no tokens, no IDs.
// ───────────────────────────────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  try {
    const conn = await xeroClient.getConnection(req.pool, req.user.orgId);
    if (!conn) return ok(res, { connected: false });
    return ok(res, {
      connected: true,
      xero_tenant_name: conn.xero_tenant_name,
      connected_at: conn.connected_at,
      last_synced_at: conn.last_synced_at,
      last_sync_status: conn.last_sync_status,
      last_sync_message: conn.last_sync_message,
    });
  } catch (err) {
    console.error('[xero/status] error:', err);
    return fail(res, 'Failed to read Xero status');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /accounts
// Pulls the org's Xero chart of accounts (filtered to BANK type — that's what
// matters for reconciliation) and overlays the current Tenafy account mapping
// so the UI can render both sides of the table in one round trip.
//
// Response: {
//   xero_accounts: [{ id, code, name, type, currencyCode, status }, ...],
//   mappings:      { [xero_account_id]: tenafy_account_setting_id, ... },
//   tenafy_accounts: [{ id, name, type }, ...],
// }
// ───────────────────────────────────────────────────────────────────────────
router.get('/accounts', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    // Bail if not connected — UI shouldn't reach this page otherwise, but be
    // defensive.
    const conn = await xeroClient.getConnection(req.pool, orgId);
    if (!conn) return fail(res, 'Xero is not connected', 400);

    // Pull from Xero. The Accounts endpoint returns the full chart of
    // accounts; we filter to BANK (and CURRENT, which Xero sometimes uses
    // for current-asset bank accounts depending on chart structure).
    const xeroResp = await xeroClient.xeroApiGet(req.pool, orgId, '/Accounts', {
      where: 'Type=="BANK"',
    });
    const xero_accounts = (xeroResp.Accounts || []).map(a => ({
      id: a.AccountID,
      code: a.Code,
      name: a.Name,
      type: a.Type,
      currencyCode: a.CurrencyCode,
      status: a.Status,
      bankAccountNumber: a.BankAccountNumber || null,
    }));

    // Existing mappings.
    const [mapRows] = await req.pool.execute(
      `SELECT xero_account_id, tenafy_account_setting_id
         FROM xero_account_map
        WHERE org_id = ?`,
      [orgId]
    );
    const mappings = {};
    for (const r of mapRows) {
      mappings[r.xero_account_id] = r.tenafy_account_setting_id
        ? String(r.tenafy_account_setting_id)
        : null;
    }

    // Tenafy accounts for the dropdown.
    const [tenafyAccounts] = await req.pool.execute(
      `SELECT id, name, type FROM account_setting
        WHERE org_id = ? AND enabled = 1 ORDER BY name`,
      [orgId]
    );
    const tenafy_accounts = tenafyAccounts.map(a => ({
      id: String(a.id),
      name: a.name,
      type: a.type,
    }));

    return ok(res, { xero_accounts, mappings, tenafy_accounts });
  } catch (err) {
    console.error('[xero/accounts] error:', err);
    // Xero-specific errors carry useful context in err.response.data.
    const detail = err.response?.data?.Detail
              || err.response?.data?.Message
              || err.message;
    return fail(res, `Failed to fetch Xero accounts: ${detail}`, 502);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /accounts/map
// Body: { mappings: [{ xero_account_id, xero_account_code, xero_account_name,
//                      xero_account_type, tenafy_account_setting_id }, ...] }
//
// Upserts the full mapping set for the org. Send the COMPLETE list every
// time (clears old rows then re-inserts) — simpler than per-row PATCH and
// the dataset is tiny (<20 rows per org).
// ───────────────────────────────────────────────────────────────────────────
router.post('/accounts/map', authenticate, async (req, res) => {
  const orgId = req.user.orgId;
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : null;
  if (!mappings) return fail(res, 'Body must include `mappings` array', 400);

  // We do this as a transaction so a half-applied state never lands in the DB.
  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM xero_account_map WHERE org_id = ?', [orgId]);

    let saved = 0;
    for (const m of mappings) {
      if (!m.xero_account_id) continue;
      // Allow unmapped rows (tenafy_account_setting_id may be null) so the
      // user can persist their "I want to map these but haven't picked yet"
      // state — useful for incremental setup.
      const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
      await conn.execute(
        `INSERT INTO xero_account_map
            (id, org_id, xero_account_id, xero_account_code, xero_account_name,
             xero_account_type, tenafy_account_setting_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          id, orgId,
          String(m.xero_account_id),
          m.xero_account_code || null,
          m.xero_account_name || null,
          m.xero_account_type || null,
          m.tenafy_account_setting_id ? String(m.tenafy_account_setting_id) : null,
        ]
      );
      saved++;
    }

    await conn.commit();
    return ok(res, { saved });
  } catch (err) {
    await conn.rollback();
    console.error('[xero/accounts/map] error:', err);
    return fail(res, 'Failed to save mappings');
  } finally {
    conn.release();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /disconnect
// Wipes the local Xero connection row. Does NOT revoke on Xero's side
// (Xero doesn't have a token-revocation endpoint exposed for app users —
// the user can revoke from their Xero Connected Apps settings if they want
// a full kill).
// ───────────────────────────────────────────────────────────────────────────
router.post('/disconnect', authenticate, async (req, res) => {
  try {
    await xeroClient.deleteConnection(req.pool, req.user.orgId);
    return ok(res, { disconnected: true });
  } catch (err) {
    console.error('[xero/disconnect] error:', err);
    return fail(res, 'Failed to disconnect Xero');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /sync
// Manual sync trigger. Pulls Xero bank transactions for the given date range
// (default: last 30 days) and stages them in xero_pending_reconciliation.
// NOTHING auto-commits to `accounting`.
//
// Body (all optional):
//   { since_date: 'YYYY-MM-DD', until_date: 'YYYY-MM-DD' }
//
// Returns the run summary so the UI can show
// "Pulled N, staged M, skipped K already-imported, errors E".
//
// This can be slow on the first run (30 days × 6 accounts × Xero pagination
// can be 30+ API calls). The frontend should show a spinner and disable the
// button until the response returns.
// ───────────────────────────────────────────────────────────────────────────
router.post('/sync', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    // Bail if not connected — nicer error than the internal "no connection" throw.
    const conn = await xeroClient.getConnection(req.pool, orgId);
    if (!conn) return fail(res, 'Xero is not connected', 400);

    const summary = await xeroSync.syncForOrg(req.pool, orgId, {
      sinceDate: req.body?.since_date,
      untilDate: req.body?.until_date,
    });
    return ok(res, summary);
  } catch (err) {
    console.error('[xero/sync] error:', err);
    return fail(res, err.response?.data?.Detail || err.message || 'Sync failed', 500);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /pending
// Returns the review queue — every row from xero_pending_reconciliation with
// status='pending' for this org, joined with display labels.
//
// Query params:
//   xero_account_id   — restrict to one bank account
//   match_kind        — restrict to one classification
//
// The shape is denormalized for the UI so it can render without N+1 lookups:
// proposed_account_name, proposed_category_name, proposed_invoice_code, etc.
// ───────────────────────────────────────────────────────────────────────────
router.get('/pending', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    let where = "p.org_id = ? AND p.status = 'pending'";
    const params = [orgId];
    if (req.query.xero_account_id) {
      where += ' AND p.xero_account_id = ?';
      params.push(String(req.query.xero_account_id));
    }
    if (req.query.match_kind) {
      where += ' AND p.match_kind = ?';
      params.push(String(req.query.match_kind));
    }

    const [rows] = await req.pool.execute(
      `SELECT p.*,
              m.xero_account_name,
              m.xero_account_code,
              ast.name AS proposed_account_name,
              cat.name AS proposed_category_name,
              inv.invoice_code AS proposed_invoice_code,
              inv.amount AS proposed_invoice_amount,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS proposed_tenant_name
         FROM xero_pending_reconciliation p
         LEFT JOIN xero_account_map m
                ON m.org_id = p.org_id AND m.xero_account_id = p.xero_account_id
         LEFT JOIN account_setting ast ON ast.id = p.proposed_account_id
         LEFT JOIN category_setting cat ON cat.id = p.proposed_category_id
         LEFT JOIN invoice inv ON inv.id = p.proposed_invoice_id
         LEFT JOIN tenant t   ON t.id   = p.proposed_tenant_id
        WHERE ${where}
        ORDER BY p.xero_account_id, p.transaction_date DESC, p.id DESC`,
      params
    );

    return ok(res, {
      pending: rows.map(r => ({
        ...r,
        id: String(r.id),
        amount: r.amount != null ? Number(r.amount) : null,
        proposed_account_id: r.proposed_account_id ? String(r.proposed_account_id) : null,
        proposed_category_id: r.proposed_category_id ? String(r.proposed_category_id) : null,
        proposed_invoice_id: r.proposed_invoice_id ? String(r.proposed_invoice_id) : null,
        proposed_tenant_id: r.proposed_tenant_id ? String(r.proposed_tenant_id) : null,
        existing_accounting_id: r.existing_accounting_id ? String(r.existing_accounting_id) : null,
        raw_payload: undefined, // don't ship the whole Xero blob to the browser
      })),
    });
  } catch (err) {
    console.error('[xero/pending] error:', err);
    return fail(res, 'Failed to load pending reconciliation');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /pending/:id/approve
// Commit a single staged row to the `accounting` table according to its
// match_kind.  Body may override proposed values:
//   { account_id?, category_id?, invoice_id?, tenant_id? }
//
// dedup_existing  → UPDATE accounting SET xero_transaction_id=..., reconciliation_status='reconciled' WHERE id=existing_accounting_id
// invoice_payment → INSERT accounting (linked to invoice) — payment row
// new_entry       → INSERT accounting (standalone) with proposed/overridden category
// ambiguous       → require body.accounting_id to be one of ambiguous_candidates; same as dedup_existing
// unmapped_account → require body.account_id (and treat as new_entry going forward)
// ───────────────────────────────────────────────────────────────────────────
router.post('/pending/:id/approve', authenticate, async (req, res) => {
  const orgId = req.user.orgId;
  const userId = req.user.id;
  const pendingId = req.params.id;
  const overrides = req.body || {};

  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p]] = await conn.execute(
      "SELECT * FROM xero_pending_reconciliation WHERE id = ? AND org_id = ? AND status = 'pending' FOR UPDATE",
      [pendingId, orgId]
    );
    if (!p) {
      await conn.rollback();
      return fail(res, 'Pending row not found or already processed', 404);
    }

    // Resolve final IDs (overrides win over proposals).
    const accountId  = overrides.account_id  || (p.proposed_account_id  ? String(p.proposed_account_id)  : null);
    const categoryId = overrides.category_id || (p.proposed_category_id ? String(p.proposed_category_id) : null);
    const invoiceId  = overrides.invoice_id  || (p.proposed_invoice_id  ? String(p.proposed_invoice_id)  : null);
    const tenantId   = overrides.tenant_id   || (p.proposed_tenant_id   ? String(p.proposed_tenant_id)   : null);
    const existingAcctId = overrides.accounting_id || (p.existing_accounting_id ? String(p.existing_accounting_id) : null);

    // Common fields for INSERTs.
    const amount = Math.abs(Number(p.amount) || 0);
    const isOutflow = Number(p.amount) < 0 ? 1 : 0;
    const note = (p.description || '').slice(0, 500);

    let resultingId = null;

    if (p.match_kind === 'dedup_existing' || p.match_kind === 'ambiguous') {
      // Just link — stamp xero_transaction_id on the chosen existing row.
      if (!existingAcctId) {
        await conn.rollback();
        return fail(res, 'No existing accounting row selected for linking', 400);
      }
      await conn.execute(
        `UPDATE accounting
            SET xero_transaction_id = ?, reconciliation_status = 'reconciled'
          WHERE id = ? AND org_id = ?`,
        [p.xero_transaction_id, existingAcctId, orgId]
      );
      resultingId = existingAcctId;
    } else if (p.match_kind === 'new_entry' || p.match_kind === 'invoice_payment' || p.match_kind === 'unmapped_account') {
      if (!accountId) {
        await conn.rollback();
        return fail(res, 'A Tenafy account is required to create the entry', 400);
      }
      const newAcctId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
      await conn.execute(
        `INSERT INTO accounting
            (id, org_id, tenant_id, lease_id,
             category, account_setting_id,
             amount, note, type, payment_date, invoice_code,
             xero_transaction_id, reconciliation_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconciled', NOW())`,
        [
          newAcctId, orgId, tenantId || null, null,
          categoryId || null, accountId,
          amount, note, isOutflow, p.transaction_date,
          null,
          p.xero_transaction_id,
        ]
      );
      // accounting_line for the amount.
      const lineId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
      await conn.execute(
        `INSERT INTO accounting_line
            (id, accounting_id, amount, category, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [lineId, newAcctId, amount, categoryId || null]
      );
      resultingId = newAcctId;

      // If invoice_payment, also link this accounting row to the invoice via
      // the accounting_line so the invoice's outstanding gets credited.
      if (p.match_kind === 'invoice_payment' && invoiceId) {
        // Get the invoice's code so the payment shows on its row.
        const [[invRow]] = await conn.execute(
          'SELECT invoice_code FROM invoice WHERE id = ?',
          [invoiceId]
        );
        if (invRow && invRow.invoice_code) {
          await conn.execute(
            'UPDATE accounting SET invoice_code = ? WHERE id = ?',
            [invRow.invoice_code, newAcctId]
          );
          await conn.execute(
            'UPDATE accounting_line SET invoice_code = ? WHERE accounting_id = ?',
            [invRow.invoice_code, newAcctId]
          );
        }
      }
    } else {
      await conn.rollback();
      return fail(res, `Unknown match_kind: ${p.match_kind}`, 400);
    }

    // Mark the staging row done.
    await conn.execute(
      `UPDATE xero_pending_reconciliation
          SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = NOW(),
              resulting_accounting_id = ?
        WHERE id = ?`,
      [userId, resultingId, pendingId]
    );

    await conn.commit();
    return ok(res, { resulting_accounting_id: resultingId });
  } catch (err) {
    await conn.rollback();
    console.error('[xero/pending/approve] error:', err);
    return fail(res, err.message || 'Failed to approve');
  } finally {
    conn.release();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /pending/:id/skip
// Mark a pending row as skipped (won't be re-proposed on next sync unless
// the user wipes the staging row manually).
// ───────────────────────────────────────────────────────────────────────────
router.post('/pending/:id/skip', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const [r] = await req.pool.execute(
      `UPDATE xero_pending_reconciliation
          SET status = 'skipped', reviewed_by_user_id = ?, reviewed_at = NOW()
        WHERE id = ? AND org_id = ? AND status = 'pending'`,
      [userId, req.params.id, orgId]
    );
    if (r.affectedRows === 0) return fail(res, 'Pending row not found or already processed', 404);
    return ok(res, { skipped: true });
  } catch (err) {
    console.error('[xero/pending/skip] error:', err);
    return fail(res, 'Failed to skip');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Categorization rules — CRUD for xero_category_rule
//
// Rules are applied during sync (xeroSync.categorize) in `priority` ascending
// order; the first description-substring match wins. They speed up future
// reconciliation runs — over a few weeks you build up a library that auto-
// categorizes 80%+ of incoming transactions correctly.
// ───────────────────────────────────────────────────────────────────────────

// GET /rules — list with category name joined for display
router.get('/rules', authenticate, async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT r.*, c.name AS category_name
         FROM xero_category_rule r
         LEFT JOIN category_setting c ON r.category_id = c.id
        WHERE r.org_id = ?
        ORDER BY r.priority ASC, r.id ASC`,
      [req.user.orgId]
    );
    return ok(res, {
      rules: rows.map(r => ({
        ...r,
        id: String(r.id),
        category_id: r.category_id ? String(r.category_id) : null,
      })),
    });
  } catch (err) {
    console.error('[xero/rules] list error:', err);
    return fail(res, 'Failed to list rules');
  }
});

// POST /rules — create. Body: { description_pattern, category_id, priority?, enabled? }
router.post('/rules', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body || {};
    const pattern = String(b.description_pattern || '').trim();
    if (!pattern) return fail(res, 'description_pattern is required', 400);
    if (!b.category_id) return fail(res, 'category_id is required', 400);
    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    await req.pool.execute(
      `INSERT INTO xero_category_rule
         (id, org_id, description_pattern, category_id, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id, orgId, pattern, String(b.category_id),
        Number.isInteger(b.priority) ? b.priority : 100,
        b.enabled === false ? 0 : 1,
      ]
    );
    return ok(res, { id });
  } catch (err) {
    console.error('[xero/rules] create error:', err);
    return fail(res, 'Failed to create rule');
  }
});

// PUT /rules/:id — update. Body: any subset of { description_pattern, category_id, priority, enabled }
router.put('/rules/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body || {};
    const fields = [];
    const params = [];
    if (b.description_pattern != null) { fields.push('description_pattern = ?'); params.push(String(b.description_pattern).trim()); }
    if (b.category_id) { fields.push('category_id = ?'); params.push(String(b.category_id)); }
    if (Number.isInteger(b.priority)) { fields.push('priority = ?'); params.push(b.priority); }
    if (b.enabled != null) { fields.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
    if (fields.length === 0) return fail(res, 'No updatable fields provided', 400);
    fields.push('updated_at = NOW()');
    params.push(req.params.id, orgId);
    const [r] = await req.pool.execute(
      `UPDATE xero_category_rule SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );
    if (r.affectedRows === 0) return fail(res, 'Rule not found', 404);
    return ok(res, { updated: true });
  } catch (err) {
    console.error('[xero/rules] update error:', err);
    return fail(res, 'Failed to update rule');
  }
});

// DELETE /rules/:id
router.delete('/rules/:id', authenticate, async (req, res) => {
  try {
    const [r] = await req.pool.execute(
      'DELETE FROM xero_category_rule WHERE id = ? AND org_id = ?',
      [req.params.id, req.user.orgId]
    );
    if (r.affectedRows === 0) return fail(res, 'Rule not found', 404);
    return ok(res, { deleted: true });
  } catch (err) {
    console.error('[xero/rules] delete error:', err);
    return fail(res, 'Failed to delete rule');
  }
});

module.exports = router;

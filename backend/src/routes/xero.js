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
const { generateSequenceCode } = require('../utils/sequenceCode');

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

    // Existing mappings. An ignored account is surfaced as the sentinel
    // '__IGNORE__' so the frontend can render it as the "Ignore (don't sync)"
    // choice in the same dropdown used for real account mappings.
    const [mapRows] = await req.pool.execute(
      `SELECT xero_account_id, tenafy_account_setting_id, ignored
         FROM xero_account_map
        WHERE org_id = ?`,
      [orgId]
    );
    const mappings = {};
    for (const r of mapRows) {
      mappings[r.xero_account_id] = r.ignored
        ? '__IGNORE__'
        : (r.tenafy_account_setting_id ? String(r.tenafy_account_setting_id) : null);
    }

    // Tenafy accounts for the dropdown.
    // NOTE: account_setting has no `type` column — just id/name/org_id/enabled.
    // The dropdown only needs id+name to render. `enabled` is BIT(1) so we
    // compare against b'1' to be safe across drivers.
    const [tenafyAccounts] = await req.pool.execute(
      `SELECT id, name FROM account_setting
        WHERE org_id = ? AND enabled = b'1' ORDER BY name`,
      [orgId]
    );
    const tenafy_accounts = tenafyAccounts.map(a => ({
      id: String(a.id),
      name: a.name,
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
// Parse a Xero BankSummary report into { [xeroAccountId]: closingBalance }.
// Layout: Reports[0].Rows → Section rows → account Rows. Each account row's
// FIRST cell carries the account UUID in Attributes[{Id:'account'}], and the
// LAST cell is the closing balance.
// ───────────────────────────────────────────────────────────────────────────
function parseBankSummary(report) {
  const out = {};
  for (const rep of (report?.Reports || [])) {
    for (const section of (rep.Rows || [])) {
      if (section.RowType !== 'Section') continue;
      for (const row of (section.Rows || [])) {
        if (row.RowType !== 'Row') continue;
        const cells = row.Cells || [];
        if (!cells.length) continue;
        let acctId = null;
        for (const attr of (cells[0].Attributes || [])) {
          if (attr.Id === 'account') { acctId = String(attr.Value); break; }
        }
        if (!acctId) continue;
        const last = cells[cells.length - 1];
        const bal = parseFloat(String(last?.Value ?? '').replace(/,/g, ''));
        if (!Number.isNaN(bal)) out[acctId] = bal;
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// GET /balances
// Reconciliation balance check. For each mapped (non-ignored) Xero bank account
// returns the Tenafy account balance (inflow − outflow over ALL transactions)
// alongside the Xero account's closing balance from the BankSummary report,
// plus a `matched` flag. Needs the accounting.reports.banksummary.read scope —
// if it isn't granted (older connection), xero_balance comes back null with a
// report_error telling the user to reconnect.
// ───────────────────────────────────────────────────────────────────────────
router.get('/balances', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const conn = await xeroClient.getConnection(req.pool, orgId);
    if (!conn) return fail(res, 'Xero is not connected', 400);

    // Mapped accounts only — skip ignored and not-yet-mapped rows.
    const [mapRows] = await req.pool.execute(
      `SELECT m.xero_account_id, m.xero_account_name, m.tenafy_account_setting_id,
              s.name AS tenafy_account_name
         FROM xero_account_map m
         LEFT JOIN account_setting s ON s.id = m.tenafy_account_setting_id
        WHERE m.org_id = ? AND m.ignored = 0 AND m.tenafy_account_setting_id IS NOT NULL`,
      [orgId]
    );
    if (!mapRows.length) return ok(res, { balances: [], report_error: null });

    // Tenafy balance per mapped account (all transactions, no date filter).
    const acctIds = mapRows.map(m => String(m.tenafy_account_setting_id));
    const [balRows] = await req.pool.execute(
      `SELECT account_setting_id,
              COALESCE(SUM(CASE WHEN type = 0 THEN amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN type = 1 THEN amount ELSE 0 END), 0) AS balance
         FROM accounting
        WHERE org_id = ? AND deleted_at IS NULL
          AND account_setting_id IN (${acctIds.map(() => '?').join(',')})
        GROUP BY account_setting_id`,
      [orgId, ...acctIds]
    );
    const tenafyBalance = {};
    for (const r of balRows) tenafyBalance[String(r.account_setting_id)] = Number(r.balance) || 0;

    // Xero closing balances from BankSummary. Closing balance is as-of toDate
    // regardless of fromDate, so a short range keeps the report light.
    const now = new Date();
    const toDate = now.toISOString().split('T')[0];
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    let xeroBalance = {};
    let reportError = null;
    try {
      const rep = await xeroClient.xeroApiGet(req.pool, orgId, '/Reports/BankSummary', { fromDate, toDate });
      xeroBalance = parseBankSummary(rep);
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.Detail
                  || err.response?.data?.Title
                  || err.response?.data?.Message
                  || err.message || '';
      // Xero rejects the report with "AuthorizationUnsuccessful" (401/403) when
      // the access token predates the reports scope — i.e. the connection was
      // authorized before we added accounting.reports.banksummary.read. The fix
      // is a reconnect (re-consent), not anything in Tenafy.
      const scopeIssue = status === 401 || status === 403
        || /authoriz|unsuccessful|scope|forbidden/i.test(String(detail));
      reportError = scopeIssue
        ? 'Xero hasn’t granted the BankSummary (reports) permission yet. Reconnect Xero to enable balances: Settings → Integrations → Disconnect, then Connect to Xero again, then click Refresh.'
        : (detail || 'Failed to load Xero balances');
    }

    const balances = mapRows.map(m => {
      const tBal = Number(tenafyBalance[String(m.tenafy_account_setting_id)] || 0);
      const xBal = xeroBalance[String(m.xero_account_id)];
      const hasXero = xBal !== undefined;
      return {
        xero_account_id: String(m.xero_account_id),
        xero_account_name: m.xero_account_name || null,
        tenafy_account_id: String(m.tenafy_account_setting_id),
        tenafy_account_name: m.tenafy_account_name || null,
        tenafy_balance: Number(tBal.toFixed(2)),
        xero_balance: hasXero ? Number(Number(xBal).toFixed(2)) : null,
        difference: hasXero ? Number((tBal - Number(xBal)).toFixed(2)) : null,
        matched: hasXero ? (Math.abs(tBal - Number(xBal)) < 0.01) : null,
      };
    });

    return ok(res, { balances, report_error: reportError });
  } catch (err) {
    console.error('[xero/balances] error:', err);
    return fail(res, 'Failed to load balances');
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
      // An account flagged for ignore comes in either as the '__IGNORE__'
      // sentinel in tenafy_account_setting_id or an explicit ignored:true.
      // Ignored rows never carry a Tenafy account target.
      const isIgnored = m.ignored === true
        || m.ignored === 1
        || m.tenafy_account_setting_id === '__IGNORE__';
      const tenafyId = (!isIgnored && m.tenafy_account_setting_id && m.tenafy_account_setting_id !== '__IGNORE__')
        ? String(m.tenafy_account_setting_id)
        : null;
      // Allow unmapped rows (tenafy_account_setting_id may be null) so the
      // user can persist their "I want to map these but haven't picked yet"
      // state — useful for incremental setup.
      const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
      await conn.execute(
        `INSERT INTO xero_account_map
            (id, org_id, xero_account_id, xero_account_code, xero_account_name,
             xero_account_type, tenafy_account_setting_id, ignored, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          id, orgId,
          String(m.xero_account_id),
          m.xero_account_code || null,
          m.xero_account_name || null,
          m.xero_account_type || null,
          tenafyId,
          isIgnored ? 1 : 0,
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
// (default: last 5 days) and stages them in xero_pending_reconciliation.
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
              m.tenafy_account_setting_id AS mapped_account_id,
              mast.name AS mapped_account_name,
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
         LEFT JOIN account_setting mast ON mast.id = m.tenafy_account_setting_id
         LEFT JOIN account_setting ast ON ast.id = p.proposed_account_id
         LEFT JOIN category_setting cat ON cat.id = p.proposed_category_id
         LEFT JOIN invoice inv ON inv.id = p.proposed_invoice_id
         LEFT JOIN tenant t   ON t.id   = p.proposed_tenant_id
        WHERE ${where}
        ORDER BY p.xero_account_id, p.transaction_date DESC, p.id DESC`,
      params
    );

    // Enrich ambiguous candidates with readable labels so the review queue can
    // show WHICH entries matched (tenant / category / note), letting the user
    // pick one to link. The stored candidates only carry ids.
    const parseCandidates = (val) => {
      try {
        const raw = typeof val === 'string' ? JSON.parse(val) : (val || []);
        return Array.isArray(raw) ? raw : [];
      } catch { return []; }
    };
    const candidateIds = new Set();
    for (const r of rows) {
      if (r.match_kind === 'ambiguous') {
        for (const c of parseCandidates(r.ambiguous_candidates)) {
          if (c.accounting_id) candidateIds.add(String(c.accounting_id));
        }
      }
    }
    const candidateLabels = {};
    if (candidateIds.size) {
      const ids = [...candidateIds];
      const placeholders = ids.map(() => '?').join(',');
      const [acctRows] = await req.pool.execute(
        `SELECT a.id, a.note, a.payment_date, a.amount,
                c.name AS category_name,
                CASE WHEN t.type = 1 THEN t.company_name
                     ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
                END AS tenant_name
           FROM accounting a
           LEFT JOIN category_setting c ON c.id = a.category
           LEFT JOIN tenant t          ON t.id = a.tenant_id
          WHERE a.id IN (${placeholders})`,
        ids
      );
      for (const a of acctRows) {
        const tenant = (a.tenant_name || '').trim();
        const parts = [
          tenant || 'No tenant',
          a.category_name || 'No category',
        ];
        if (a.note) parts.push(String(a.note).slice(0, 40));
        candidateLabels[String(a.id)] = parts.join(' · ');
      }
    }

    return ok(res, {
      pending: rows.map(r => {
        // A row staged as 'unmapped_account' BEFORE the user mapped its Xero
        // account still carries the old classification + a null proposed
        // account. The account map is now joined in, so resolve the mapping
        // live: surface the mapped Tenafy account and reclassify the row as a
        // normal new_entry so it stops showing as "Unmapped" in the queue.
        const mappedAcctId = r.mapped_account_id ? String(r.mapped_account_id) : null;
        const storedAcctId = r.proposed_account_id ? String(r.proposed_account_id) : null;
        const effectiveAcctId = storedAcctId || mappedAcctId;
        const effectiveAcctName = r.proposed_account_name || r.mapped_account_name || null;
        const matchKind = (r.match_kind === 'unmapped_account' && mappedAcctId)
          ? 'new_entry'
          : r.match_kind;
        const enrichedCandidates = r.match_kind === 'ambiguous'
          ? parseCandidates(r.ambiguous_candidates).map(c => ({
              accounting_id: c.accounting_id ? String(c.accounting_id) : null,
              tenant_id: c.tenant_id ? String(c.tenant_id) : null,
              lease_id: c.lease_id ? String(c.lease_id) : null,
              label: candidateLabels[String(c.accounting_id)] || `Entry ${c.accounting_id}`,
            }))
          : undefined;
        return {
          ...r,
          id: String(r.id),
          amount: r.amount != null ? Number(r.amount) : null,
          match_kind: matchKind,
          ambiguous_candidates: enrichedCandidates,
          proposed_account_id: effectiveAcctId,
          proposed_account_name: effectiveAcctName,
          proposed_category_id: r.proposed_category_id ? String(r.proposed_category_id) : null,
          proposed_invoice_id: r.proposed_invoice_id ? String(r.proposed_invoice_id) : null,
          proposed_tenant_id: r.proposed_tenant_id ? String(r.proposed_tenant_id) : null,
          existing_accounting_id: r.existing_accounting_id ? String(r.existing_accounting_id) : null,
          raw_payload: undefined, // don't ship the whole Xero blob to the browser
          mapped_account_id: undefined,
          mapped_account_name: undefined,
        };
      }),
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
// Commit a single staged row to `accounting`. Returns the resulting accounting
// id. Throws an Error (with .httpStatus) on validation problems so callers can
// surface a clean message. Used by both the single and bulk approve routes.
async function commitPendingRow(pool, orgId, userId, pendingId, overrides = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p]] = await conn.execute(
      "SELECT * FROM xero_pending_reconciliation WHERE id = ? AND org_id = ? AND status = 'pending' FOR UPDATE",
      [pendingId, orgId]
    );
    if (!p) {
      // Not pending — but if it was already approved (e.g. a duplicate/stale
      // Approve click, or a re-submitted bulk request), treat it as an
      // idempotent success instead of a hard failure so it doesn't surface as a
      // confusing "skipped" row. Only a genuinely unknown id is an error.
      const [[done]] = await conn.execute(
        "SELECT status, resulting_accounting_id FROM xero_pending_reconciliation WHERE id = ? AND org_id = ?",
        [pendingId, orgId]
      );
      await conn.rollback();
      if (done && done.status === 'approved') {
        return done.resulting_accounting_id ? String(done.resulting_accounting_id) : null;
      }
      const e = new Error(done ? `Row already ${done.status}` : 'Pending row not found');
      e.httpStatus = done ? 409 : 404;
      throw e;
    }

    let accountId    = overrides.account_id  || (p.proposed_account_id  ? String(p.proposed_account_id)  : null);
    const categoryId = overrides.category_id || (p.proposed_category_id ? String(p.proposed_category_id) : null);

    // If the row has no account yet (e.g. staged as 'unmapped_account' before
    // the Xero account was mapped), fall back to the current account mapping.
    // This lets a user map the account, then approve the queued rows directly
    // without re-syncing or manually picking the account on every row.
    if (!accountId) {
      const [[mapRow]] = await conn.execute(
        `SELECT tenafy_account_setting_id FROM xero_account_map
          WHERE org_id = ? AND xero_account_id = ? LIMIT 1`,
        [orgId, p.xero_account_id]
      );
      if (mapRow && mapRow.tenafy_account_setting_id) {
        accountId = String(mapRow.tenafy_account_setting_id);
      }
    }
    const invoiceId  = overrides.invoice_id  || (p.proposed_invoice_id  ? String(p.proposed_invoice_id)  : null);
    const tenantId   = overrides.tenant_id   || (p.proposed_tenant_id   ? String(p.proposed_tenant_id)   : null);
    const existingAcctId = overrides.accounting_id || (p.existing_accounting_id ? String(p.existing_accounting_id) : null);

    const amount = Math.abs(Number(p.amount) || 0);
    // Direction defaults to the staged amount sign, but the user can override it
    // per row from the Inflow/Outflow dropdown in the review queue (important for
    // rows pulled before the sign fix, which are stored positive).
    let isOutflow = Number(p.amount) < 0 ? 1 : 0;
    if (overrides.direction === 'outflow') isOutflow = 1;
    else if (overrides.direction === 'inflow') isOutflow = 0;
    const note = (p.description || '').slice(0, 500);

    // Resolve the org's current currency — accounting.currency_id has no default,
    // so a new entry must supply it (same lookup as the manual accounting create).
    let currencyId = null;
    let currencyType = null;
    {
      const [[curr]] = await conn.execute(
        'SELECT id, detail FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1',
        [orgId]
      );
      if (curr) {
        currencyId = curr.id;
        try {
          const detail = typeof curr.detail === 'string' ? JSON.parse(curr.detail) : curr.detail;
          currencyType = detail?.code || null;
        } catch (e) { /* ignore */ }
      }
    }

    let resultingId = null;

    // An ambiguous row can be resolved two ways: LINK to one of the candidate
    // entries the user picked, or CREATE A NEW entry (when none of them is
    // actually the same transaction). We route to the link path only when an
    // accounting_id was chosen; otherwise it falls through to the new-entry
    // path below (which requires an account).
    const isAmbiguousLink = p.match_kind === 'ambiguous' && existingAcctId;

    if (isAmbiguousLink) {
      // Guard: the chosen entry must be one of the staged candidates — don't
      // let an arbitrary accounting id be linked.
      let candidateIds = [];
      try {
        const raw = typeof p.ambiguous_candidates === 'string'
          ? JSON.parse(p.ambiguous_candidates)
          : (p.ambiguous_candidates || []);
        candidateIds = (raw || []).map(c => String(c.accounting_id));
      } catch { candidateIds = []; }
      if (candidateIds.length && !candidateIds.includes(String(existingAcctId))) {
        await conn.rollback();
        const e = new Error('Chosen entry is not one of the matching candidates');
        e.httpStatus = 400;
        throw e;
      }
    }

    // Does this row link to an existing entry? dedup_existing and ambiguous
    // (with a chosen candidate) both link. A dedup_existing row whose link
    // target wasn't captured at staging time is NOT silently failed: if the
    // user picked an account we create it as a new entry; otherwise we surface
    // a clear, actionable error instead of the cryptic original.
    const wantsLink = p.match_kind === 'dedup_existing' || isAmbiguousLink;

    if (wantsLink && existingAcctId) {
      await conn.execute(
        `UPDATE accounting SET xero_transaction_id = ?, reconciliation_status = 'reconciled'
          WHERE id = ? AND org_id = ?`,
        [p.xero_transaction_id, existingAcctId, orgId]
      );
      resultingId = existingAcctId;
    } else if (wantsLink && !existingAcctId && !accountId) {
      await conn.rollback();
      const e = new Error('This transaction was matched to an existing Tenafy entry, but the link target is missing. Pick a Tenafy account to record it as a new entry instead, or Skip it.');
      e.httpStatus = 400;
      throw e;
    } else if (
      wantsLink ||                              // link target missing but account chosen → create new
      p.match_kind === 'new_entry' ||
      p.match_kind === 'invoice_payment' ||
      p.match_kind === 'unmapped_account' ||
      p.match_kind === 'ambiguous'
    ) {
      if (!accountId) {
        await conn.rollback();
        const e = new Error('A Tenafy account is required to create the entry');
        e.httpStatus = 400;
        throw e;
      }
      const newAcctId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
      // accounting.transaction_code is NOT NULL with no default — generate one
      // from the org's sequence (same as the manual accounting create). Run it
      // on `conn` so the FOR UPDATE lock lives inside this approve transaction.
      const transactionCode = await generateSequenceCode(conn, orgId, 'transaction_code');
      await conn.execute(
        `INSERT INTO accounting
            (id, org_id, tenant_id, lease_id, category, account_setting_id,
             currency_id, currency_type,
             amount, note, type, payment_date, invoice_code,
             transaction_code, xero_transaction_id, reconciliation_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconciled', NOW())`,
        [newAcctId, orgId, tenantId || null, null, categoryId || null, accountId,
         currencyId, currencyType,
         amount, note, isOutflow, p.transaction_date, null, transactionCode, p.xero_transaction_id]
      );
      const lineId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
      await conn.execute(
        `INSERT INTO accounting_line (id, accounting_id, amount, category, created_at) VALUES (?, ?, ?, ?, NOW())`,
        [lineId, newAcctId, amount, categoryId || null]
      );
      resultingId = newAcctId;

      if (p.match_kind === 'invoice_payment' && invoiceId) {
        const [[invRow]] = await conn.execute('SELECT invoice_code FROM invoice WHERE id = ?', [invoiceId]);
        if (invRow && invRow.invoice_code) {
          await conn.execute('UPDATE accounting SET invoice_code = ? WHERE id = ?', [invRow.invoice_code, newAcctId]);
          await conn.execute('UPDATE accounting_line SET invoice_code = ? WHERE accounting_id = ?', [invRow.invoice_code, newAcctId]);
        }
      }
    } else {
      await conn.rollback();
      const e = new Error(`Unknown match_kind: ${p.match_kind}`);
      e.httpStatus = 400;
      throw e;
    }

    await conn.execute(
      `UPDATE xero_pending_reconciliation
          SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = NOW(), resulting_accounting_id = ?
        WHERE id = ?`,
      [userId, resultingId, pendingId]
    );
    await conn.commit();
    return resultingId;
  } catch (err) {
    try { await conn.rollback(); } catch { /* already rolled back */ }
    throw err;
  } finally {
    conn.release();
  }
}

router.post('/pending/:id/approve', authenticate, async (req, res) => {
  try {
    const resultingId = await commitPendingRow(req.pool, req.user.orgId, req.user.id, req.params.id, req.body || {});
    return ok(res, { resulting_accounting_id: resultingId });
  } catch (err) {
    console.error('[xero/pending/approve] error:', err);
    return fail(res, err.message || 'Failed to approve', err.httpStatus || 500);
  }
});

// Bulk approve — body { items: [{ id, account_id?, category_id?, invoice_id?,
// tenant_id?, accounting_id? }] } OR { ids: [...] } using proposed values.
// Each row commits in its own transaction; failures don't block the rest.
router.post('/pending/bulk-approve', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items
      : Array.isArray(body.ids) ? body.ids.map(id => ({ id }))
      : [];
    if (!items.length) return fail(res, 'No rows selected', 400);

    const approved = [];
    const failed = [];
    for (const it of items) {
      const { id, ...overrides } = it;
      try {
        const resultingId = await commitPendingRow(req.pool, orgId, userId, String(id), overrides);
        approved.push({ id: String(id), resulting_accounting_id: resultingId });
      } catch (err) {
        failed.push({ id: String(id), reason: err.message || 'Failed' });
      }
    }
    return ok(res, { approved, failed, approved_count: approved.length, failed_count: failed.length });
  } catch (err) {
    console.error('[xero/pending/bulk-approve] error:', err);
    return fail(res, err.message || 'Bulk approve failed', 500);
  }
});

// Bulk skip — body { ids: [...] }. Marks each pending row skipped.
router.post('/pending/bulk-skip', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return fail(res, 'No rows selected', 400);
    const placeholders = ids.map(() => '?').join(',');
    const [r] = await req.pool.execute(
      `UPDATE xero_pending_reconciliation
          SET status = 'skipped', reviewed_by_user_id = ?, reviewed_at = NOW()
        WHERE org_id = ? AND status = 'pending' AND id IN (${placeholders})`,
      [userId, orgId, ...ids]
    );
    return ok(res, { skipped_count: r.affectedRows });
  } catch (err) {
    console.error('[xero/pending/bulk-skip] error:', err);
    return fail(res, 'Bulk skip failed', 500);
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

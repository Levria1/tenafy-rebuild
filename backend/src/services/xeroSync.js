/**
 * Xero sync engine — pulls bank transactions from Xero and stages them as
 * proposals in `xero_pending_reconciliation`. Nothing auto-commits to the
 * `accounting` table; user reviews + approves on /accounting/reconcile.
 *
 * Match strategy per Xero transaction (in priority order):
 *
 *   1. **Already imported** — `xero_transaction_id` exists in `accounting`.
 *      Skip entirely (no staging row created).
 *
 *   2. **Dedup against manual entry** — same date + same amount + same
 *      mapped Tenafy account in `accounting`. If EXACTLY 1 match:
 *        → match_kind='dedup_existing', proposes to stamp xero_transaction_id
 *          on that row (link, not duplicate).
 *      If MULTIPLE matches:
 *        → match_kind='ambiguous', user picks which one in the review queue.
 *
 *   3. **Invoice payment match** — open invoice with the same amount + payer
 *      name in the description. If found:
 *        → match_kind='invoice_payment', proposes a payment against that
 *          invoice.
 *
 *   4. **New entry** — no match anywhere. Proposes a new accounting row in
 *      the mapped account, with category from rules or LLM.
 *
 *   5. **Unmapped account** — the Xero bank account isn't in xero_account_map
 *      yet. Stage anyway with match_kind='unmapped_account' so the user sees
 *      it in the queue and can either map the account or skip the row.
 *
 * Entry point: syncForOrg(pool, orgId, { sinceDate?, untilDate? })
 *   - Both date bounds optional. Default: last 30 days, until today.
 *   - Returns { pulled, staged, skipped_already_imported, errors }.
 *
 * Manual trigger only — no cron. The user clicks "Sync Now" on the
 * /accounting/reconcile page which hits POST /api/integrations/xero/sync.
 */

const xeroClient = require('./xeroClient');
const llmClient = require('./llmClient');

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

function fmtDate(d) {
  if (!d) return null;
  return new Date(d).toISOString().split('T')[0];
}

// Xero returns dates as "/Date(1700000000000+0000)/" strings. Parse to ISO.
function parseXeroDate(s) {
  if (!s) return null;
  const m = String(s).match(/\/Date\((-?\d+)/);
  if (!m) return new Date(s);
  return new Date(parseInt(m[1], 10));
}

// ───────────────────────────────────────────────────────────────────────────
// Matchers — pure functions over a single Xero transaction + lookup helpers.
// Kept small so each can be tested in isolation if we add unit tests later.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Already imported? Look up by xero_transaction_id.
 * Returns the accounting row's id if found, else null.
 */
async function findAlreadyImported(pool, orgId, xeroTxId) {
  const [[row]] = await pool.execute(
    `SELECT id FROM accounting
      WHERE org_id = ? AND xero_transaction_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [orgId, xeroTxId]
  );
  return row ? String(row.id) : null;
}

/**
 * Dedup matcher: find Tenafy accounting entries that EXACTLY match the Xero
 * transaction — same payment date AND same amount. Nothing else counts.
 *
 * Strict by design: a Tenafy entry is only considered "the same transaction"
 * when its date and amount line up exactly with Xero. A near-date or near-amount
 * row is treated as a different transaction (→ new_entry), not a fuzzy match.
 * This keeps the review queue unambiguous: an entry either is the same record
 * or it isn't.
 *
 * Why account-scoped: without it, a $13k rent payment on the same day in two
 * different banks would falsely collide. The mapped Tenafy account is the
 * tightest natural key besides xero_transaction_id itself. When the Xero bank
 * account isn't mapped yet (tenafyAccountId null) we search across all accounts
 * so an already-recorded entry is still detected instead of proposed as new.
 *
 * Returns an array of {id, amount, type, payment_date, tenant_id, ...} —
 * caller decides whether to link (1 match) or flag ambiguous (≥2, i.e. two
 * genuinely identical date+amount rows, which is rare and worth a human pick).
 */
async function findDedupCandidates(pool, orgId, { date, amount, tenafyAccountId }) {
  const params = [orgId];
  let accountClause = '';
  if (tenafyAccountId) {
    accountClause = 'AND account_setting_id = ?';
    params.push(tenafyAccountId);
  }
  // Exact day (DATE() strips any time component) + exact amount.
  params.push(date);
  params.push(Math.abs(amount));

  const [rows] = await pool.execute(
    `SELECT id, amount, type, payment_date, tenant_id, lease_id, category, account_setting_id
       FROM accounting
      WHERE org_id = ?
        AND deleted_at IS NULL
        ${accountClause}
        AND DATE(payment_date) = ?
        AND amount = ?
        AND (xero_transaction_id IS NULL OR xero_transaction_id = '')
      ORDER BY id ASC`,
    params
  );
  return rows.map(r => ({ ...r, id: String(r.id) }));
}

/**
 * Invoice payment matcher: find open invoices with the same amount where the
 * tenant's name shows up in the Xero transaction description / contact_name.
 *
 * Conservative: requires BOTH the amount match AND a name token to appear in
 * the description. A bare amount-match alone is too loose — Hong Kong rentals
 * often share round numbers ($10k, $15k) and we don't want to silently link
 * the wrong tenant.
 */
async function findInvoiceMatch(pool, orgId, { amount, description, contactName, date }) {
  const haystack = [description, contactName].filter(Boolean).join(' ').toLowerCase();
  if (!haystack) return null;

  // Pull open invoices with this amount in the +/- 30 day window. 30 days
  // because rent paid 3 weeks early or 1 week late is common.
  const dateLow  = new Date(new Date(date).getTime() - 30 * 86400000).toISOString().split('T')[0];
  const dateHigh = new Date(new Date(date).getTime() + 30 * 86400000).toISOString().split('T')[0];
  const [rows] = await pool.execute(
    `SELECT i.id, i.amount, i.tenant_id, i.leasing_id, i.due_on,
            t.first_name, t.last_name, t.company_name, t.type AS tenant_type
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
      WHERE i.org_id = ?
        AND i.deleted_at IS NULL
        AND i.status != 1
        AND i.amount = ?
        AND i.due_on BETWEEN ? AND ?`,
    [orgId, Math.abs(amount), dateLow, dateHigh]
  );

  // Match by name token appearing in description.
  for (const inv of rows) {
    const candidates = [];
    if (inv.first_name)   candidates.push(String(inv.first_name).toLowerCase());
    if (inv.last_name)    candidates.push(String(inv.last_name).toLowerCase());
    if (inv.company_name) candidates.push(String(inv.company_name).toLowerCase());
    const hit = candidates.find(c => c.length >= 3 && haystack.includes(c));
    if (hit) {
      return {
        invoice_id: String(inv.id),
        tenant_id: inv.tenant_id ? String(inv.tenant_id) : null,
        leasing_id: inv.leasing_id ? String(inv.leasing_id) : null,
        matched_name_token: hit,
      };
    }
  }
  return null;
}

/**
 * Categorization: try user-defined rules first, then optionally LLM fallback.
 * Returns { category_id, rule_id } where either may be null.
 *
 * LLM fallback is gated to amounts above $X to keep cost predictable. Caller
 * can pass enableLlm=false to skip entirely.
 */
async function categorize(pool, orgId, { description, amount, xeroCategoryName = null, enableLlm = false }) {
  // Rules first (priority asc, lower runs earlier — so 1 beats 100).
  const [rules] = await pool.execute(
    `SELECT id, description_pattern, category_id FROM xero_category_rule
      WHERE org_id = ? AND enabled = 1
      ORDER BY priority ASC, id ASC`,
    [orgId]
  );
  const haystack = String(description || '').toLowerCase();
  for (const r of rules) {
    const needle = String(r.description_pattern || '').toLowerCase();
    if (!needle) continue;
    if (haystack.includes(needle)) {
      // Bump hit_count async (don't block sync on it).
      pool.execute(
        'UPDATE xero_category_rule SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE id = ?',
        [r.id]
      ).catch(() => {});
      return { category_id: String(r.category_id), rule_id: String(r.id), source: 'rule' };
    }
  }
  // Xero account name → Tenafy category (exact, case-insensitive). The Xero
  // line account IS the category in Xero's chart of accounts; if Tenafy has a
  // category of the same name, use it directly. Runs regardless of amount, so
  // small transactions (below the LLM gate) still auto-categorize.
  if (xeroCategoryName) {
    const [catHits] = await pool.execute(
      `SELECT id FROM category_setting
        WHERE org_id = ? AND enabled = 1 AND LOWER(name) = LOWER(?) LIMIT 1`,
      [orgId, String(xeroCategoryName).trim()]
    );
    if (catHits.length) {
      return { category_id: String(catHits[0].id), rule_id: null, source: 'xero_account_name' };
    }
  }
  // LLM fallback — only when explicitly enabled and amount is non-trivial.
  // Gate by amount to keep cost predictable: trivial amounts (e.g. <$100 HKD)
  // can stay uncategorized and the user picks during review.
  if (enableLlm && Math.abs(amount) >= 100) {
    try {
      const [categoryRows] = await pool.execute(
        `SELECT id, name FROM category_setting
          WHERE org_id = ? AND enabled = 1 ORDER BY name`,
        [orgId]
      );
      if (categoryRows.length === 0) {
        return { category_id: null, rule_id: null, source: 'none' };
      }
      // System prompt is constrained: the LLM MUST return one category name
      // verbatim from the list, OR "UNKNOWN". No other output is accepted.
      // We rely on the strict-output instruction + low temperature to keep
      // it from inventing categories.
      const categoryNames = categoryRows.map(c => c.name);
      const systemPrompt = [
        'You categorize a single bank transaction description into one of the allowed categories.',
        'The transaction is from a Hong Kong property management business.',
        'Reply with EXACTLY ONE LINE containing only the category name verbatim from this list:',
        categoryNames.map(n => `  - ${n}`).join('\n'),
        'Or reply with the single word UNKNOWN if no category is a confident match.',
        'Do not include explanatory prose, quotes, punctuation, or any other text.',
      ].join('\n');
      const userPrompt = [
        `Description: ${description || '(no description)'}`,
        `Amount: ${amount} HKD (${amount < 0 ? 'outflow' : 'inflow'})`,
      ].join('\n');

      const resp = await llmClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        null,
        { temperature: 0 }
      );
      const raw = (resp.message && resp.message.content) || '';
      const guess = raw.split('\n')[0].trim();
      if (!guess || guess === 'UNKNOWN') {
        return { category_id: null, rule_id: null, source: 'llm_unknown' };
      }
      const hit = categoryRows.find(c => c.name.toLowerCase() === guess.toLowerCase());
      if (hit) {
        return { category_id: String(hit.id), rule_id: null, source: 'llm' };
      }
      // LLM returned a name not on our list — log + give up. Don't trust the LLM.
      console.warn('[xeroSync.categorize] LLM returned unknown category:', guess);
    } catch (err) {
      console.error('[xeroSync.categorize] LLM error:', err.message);
      // Non-fatal — fall through to "none". Sync continues without categorization.
    }
  }
  return { category_id: null, rule_id: null, source: 'none' };
}

// ───────────────────────────────────────────────────────────────────────────
// Main sync function
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pull bank transactions from Xero for the org, stage each as a proposal in
 * xero_pending_reconciliation. Does NOT commit anything to `accounting` —
 * that happens later via the review queue's Approve action.
 */
async function syncForOrg(pool, orgId, opts = {}) {
  // Default look-back window when the caller doesn't pass an explicit range.
  const DEFAULT_SYNC_DAYS = 5;
  const sinceDate = opts.sinceDate
    || new Date(Date.now() - DEFAULT_SYNC_DAYS * 86400000).toISOString().split('T')[0];
  const untilDate = opts.untilDate || new Date().toISOString().split('T')[0];

  const summary = {
    pulled: 0,
    staged: 0,
    skipped_already_imported: 0,
    skipped_ignored: 0,
    errors: 0,
    error_details: [],
  };

  // Load the org's account map once — we use it to scope dedup queries and to
  // know which Xero accounts are flagged "ignore" (skip entirely at pull time).
  const [mapRows] = await pool.execute(
    `SELECT xero_account_id, tenafy_account_setting_id, ignored
       FROM xero_account_map
      WHERE org_id = ?`,
    [orgId]
  );
  const accountMap = {};
  const ignoredSet = new Set();
  for (const r of mapRows) {
    accountMap[r.xero_account_id] = r.tenafy_account_setting_id
      ? String(r.tenafy_account_setting_id)
      : null;
    if (r.ignored) ignoredSet.add(r.xero_account_id);
  }

  // Build a Xero chart-of-accounts code→name map once per sync. Each
  // transaction line carries an AccountCode (Xero's "category"); we resolve it
  // to the account name so categorize() can match it against a Tenafy category
  // of the same name. Non-fatal if it fails — we fall back to rule/LLM matching.
  const xeroAccountNames = {};
  try {
    const acctResp = await xeroClient.xeroApiGet(pool, orgId, '/Accounts');
    for (const a of (acctResp.Accounts || [])) {
      if (a.Code) xeroAccountNames[String(a.Code)] = a.Name;
    }
  } catch (err) {
    console.warn('[xeroSync] could not load chart of accounts for category matching:', err.message);
  }

  // Xero's BankTransactions endpoint paginates at 100/page. Loop until empty.
  // The Where clause filters by date range; Xero expects a specific DateTime
  // literal syntax — DateTime(yyyy,mm,dd).
  const [sy, sm, sd] = sinceDate.split('-').map(Number);
  const [uy, um, ud] = untilDate.split('-').map(Number);
  const whereClause = `Date >= DateTime(${sy},${sm},${sd}) && Date <= DateTime(${uy},${um},${ud})`;

  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    try {
      resp = await xeroClient.xeroApiGet(pool, orgId, '/BankTransactions', {
        where: whereClause,
        page,
        order: 'Date ASC',
      });
    } catch (err) {
      summary.errors++;
      summary.error_details.push(`Page ${page}: ${err.response?.data?.Detail || err.message}`);
      break;
    }

    const txns = resp.BankTransactions || [];
    if (txns.length === 0) break;

    for (const tx of txns) {
      summary.pulled++;
      // Ignored account → drop the transaction before it ever reaches the
      // review queue. No staging, no "Unmapped" clutter.
      if (ignoredSet.has(tx.BankAccount?.AccountID)) {
        summary.skipped_ignored++;
        continue;
      }
      try {
        await stageTransaction(pool, orgId, tx, accountMap, xeroAccountNames);
        summary.staged++;
      } catch (err) {
        if (err && err.skipReason === 'already_imported') {
          summary.skipped_already_imported++;
        } else if (err && err.skipReason === 'already_staged') {
          // Already in the pending queue from a previous sync — that's fine.
        } else {
          summary.errors++;
          summary.error_details.push(`Tx ${tx.BankTransactionID}: ${err.message}`);
        }
      }
    }

    // Xero usually returns max 100 per page. If we got less, we're done.
    if (txns.length < 100) break;
    page++;
  }

  // Stamp the connection row so the UI can show "last synced at".
  await pool.execute(
    `UPDATE xero_connection
        SET last_synced_at = NOW(),
            last_sync_status = ?,
            last_sync_message = ?
      WHERE org_id = ?`,
    [
      summary.errors > 0 ? 'error' : 'ok',
      summary.errors > 0 ? summary.error_details.slice(0, 3).join(' | ') : null,
      orgId,
    ]
  );

  return summary;
}

/**
 * Stage a single Xero transaction. Internal — called per row inside syncForOrg.
 * Throws { skipReason } for non-error skip cases so the caller can categorize.
 */
async function stageTransaction(pool, orgId, tx, accountMap, xeroAccountNames = {}) {
  const xeroTxId = tx.BankTransactionID;
  if (!xeroTxId) throw new Error('Missing BankTransactionID on Xero transaction');

  // 1. Already imported? Skip.
  const existingId = await findAlreadyImported(pool, orgId, xeroTxId);
  if (existingId) {
    const e = new Error('already imported');
    e.skipReason = 'already_imported';
    throw e;
  }

  // Pull the basic fields. Xero's BankTransaction has Type=RECEIVE|SPEND etc.
  // We treat RECEIVE as inflow (Tenafy type=0), SPEND as outflow (type=1).
  const date = parseXeroDate(tx.Date);
  const dateStr = fmtDate(date);
  // Xero's BankTransaction.Total is ALWAYS positive; direction is carried by
  // tx.Type (SPEND* = money out, RECEIVE* = money in), NOT by the sign. Apply
  // the sign here so the stored amount is negative for outflows — the approve
  // path (isOutflow), the Inflow/Outflow display, and categorize() all key off
  // this sign. Matchers (dedup/invoice) Math.abs() it, so they're unaffected.
  const total = Math.abs(Number(tx.Total) || 0);
  const isSpend = typeof tx.Type === 'string' && tx.Type.toUpperCase().startsWith('SPEND');
  const amount = isSpend ? -total : total;
  const xeroAccountId = tx.BankAccount?.AccountID;
  const contactName = tx.Contact?.Name || null;
  // Concatenate line item descriptions to feed matching/categorization.
  const lineDescriptions = (tx.LineItems || [])
    .map(li => li.Description)
    .filter(Boolean)
    .join(' | ');
  const reference = tx.Reference || null;
  const description = [reference, lineDescriptions].filter(Boolean).join(' — ');
  const currencyCode = tx.CurrencyCode || null;
  const tenafyAccountId = accountMap[xeroAccountId] || null;

  // Xero's line account is its "category". Take the first line with an account
  // code and resolve it to its account name so categorize() can match it to a
  // Tenafy category of the same name.
  const lineAccountCode = (tx.LineItems || []).map(li => li.AccountCode).find(Boolean) || null;
  const xeroCategoryName = lineAccountCode ? (xeroAccountNames[String(lineAccountCode)] || null) : null;

  // 2. Dedup matcher (account-scoped).
  let matchKind, proposedInvoiceId = null, proposedTenantId = null, existingAccountingId = null;
  let ambiguousCandidates = null, confidence = 'medium';

  // Dedup runs in BOTH cases — when the account is mapped (scoped to that
  // account) and when it's unmapped (cross-account). This is the fix for
  // "existing entries showing as Unmapped": even before the Xero account is
  // mapped, an already-recorded Tenafy entry with the same amount + nearby
  // date is detected and proposed for linking, not as a brand-new row.
  const dedup = await findDedupCandidates(pool, orgId, {
    date: dateStr, amount, tenafyAccountId,
  });

  if (dedup.length === 1) {
    matchKind = 'dedup_existing';
    existingAccountingId = dedup[0].id;
    confidence = 'high';
  } else if (dedup.length >= 2) {
    matchKind = 'ambiguous';
    ambiguousCandidates = dedup.map(d => ({
      accounting_id: d.id,
      tenant_id: d.tenant_id ? String(d.tenant_id) : null,
      lease_id: d.lease_id ? String(d.lease_id) : null,
    }));
    confidence = 'low';
  } else if (!tenafyAccountId) {
    // No existing entry AND the account isn't mapped — genuinely new, but we
    // can't auto-create it until the user maps the Xero account to a Tenafy one.
    matchKind = 'unmapped_account';
    confidence = 'low';
  } else {
    // 3. Invoice match (only for inflows — outflows don't pay invoices).
    const isInflow = !isSpend;
    if (isInflow) {
      const invMatch = await findInvoiceMatch(pool, orgId, {
        amount, description, contactName, date: dateStr,
      });
      if (invMatch) {
        matchKind = 'invoice_payment';
        proposedInvoiceId = invMatch.invoice_id;
        proposedTenantId = invMatch.tenant_id;
        confidence = 'high';
      }
    }
    // 4. Fallback: new entry.
    if (!matchKind) {
      matchKind = 'new_entry';
      confidence = 'medium';
    }
  }

  // Categorize (rules first; LLM stubbed). Skipped for dedup_existing since
  // the existing row already has a category.
  let categoryId = null, ruleId = null;
  if (matchKind === 'new_entry' || matchKind === 'invoice_payment') {
    // enableLlm=true — rules run first; LLM is only consulted if no rule
    // matched AND the amount is above the threshold inside categorize().
    const cat = await categorize(pool, orgId, { description, amount, xeroCategoryName, enableLlm: true });
    categoryId = cat.category_id;
    ruleId = cat.rule_id;
  }

  // Upsert into staging. The UNIQUE (org_id, xero_transaction_id) constraint
  // means a re-sync replaces the proposal rather than duplicating.
  const id = newId();
  await pool.execute(
    `INSERT INTO xero_pending_reconciliation
       (id, org_id, xero_transaction_id, xero_account_id, transaction_date,
        amount, currency_code, reference, description, contact_name, raw_payload,
        match_kind, proposed_account_id, proposed_category_id, proposed_invoice_id,
        proposed_tenant_id, existing_accounting_id, ambiguous_candidates,
        confidence, rule_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
     ON DUPLICATE KEY UPDATE
        transaction_date = VALUES(transaction_date),
        amount = VALUES(amount),
        currency_code = VALUES(currency_code),
        reference = VALUES(reference),
        description = VALUES(description),
        contact_name = VALUES(contact_name),
        raw_payload = VALUES(raw_payload),
        match_kind = VALUES(match_kind),
        proposed_account_id = VALUES(proposed_account_id),
        proposed_category_id = VALUES(proposed_category_id),
        proposed_invoice_id = VALUES(proposed_invoice_id),
        proposed_tenant_id = VALUES(proposed_tenant_id),
        existing_accounting_id = VALUES(existing_accounting_id),
        ambiguous_candidates = VALUES(ambiguous_candidates),
        confidence = VALUES(confidence),
        rule_id = VALUES(rule_id)`,
    [
      id, orgId, xeroTxId, xeroAccountId, dateStr,
      amount, currencyCode, reference, description, contactName,
      JSON.stringify(tx),
      matchKind, tenafyAccountId, categoryId, proposedInvoiceId,
      proposedTenantId, existingAccountingId,
      ambiguousCandidates ? JSON.stringify(ambiguousCandidates) : null,
      confidence, ruleId,
    ]
  );
}

module.exports = { syncForOrg };

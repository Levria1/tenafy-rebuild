const xero = require('./xeroClient');
const caches = new WeakMap();
const TTL = 5 * 60000;
const normal = id => typeof id === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id) ? id.replace(/-/g,'').toLowerCase() : null;
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status, bankCatalogError:true }); };

async function binding(pool, orgId) {
  const [[row]] = await pool.execute(`SELECT b.ui_org_slug,b.xero_tenant_id,c.xero_tenant_id AS connected_tenant_id
    FROM xero_browser_binding b JOIN xero_connection c ON c.org_id=b.org_id WHERE b.org_id=?`, [orgId]);
  if (!row || row.xero_tenant_id !== row.connected_tenant_id) fail('Xero organisation binding needs verification.');
  return row;
}

async function metadata(pool, orgId, tenantId, options) {
  let cache = caches.get(pool); if (!cache) caches.set(pool, cache = new Map());
  const key = String(orgId) + ':' + tenantId;
  const cached = cache.get(key);
  if (!options.getRemote && cached && cached.until > Date.now()) return cached.promise;
  const promise = (async () => {
    const response = await (options.getRemote || xero.xeroApiGet)(pool, orgId, '/Accounts', { where: 'Type=="BANK"' });
    const current = await binding(pool, orgId);
    if (current.xero_tenant_id !== tenantId) fail('Xero connection changed. Reconnect the helper.');
    if (!Array.isArray(response?.Accounts)) fail('Xero did not return a bank account catalogue.', 503);
    return { accounts:response.Accounts, verified_at:new Date().toISOString() };
 })();
  if (!options.getRemote) {
    cache.set(key, { promise, until: Date.now() + TTL });
    promise.catch(() => { if (cache.get(key)?.promise === promise) cache.get(key).until = Date.now() + 30000; });
  }
  return promise;
}
async function deadline(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Xero bank verification timed out. Retry shortly.'), {status:503,bankCatalogError:true})), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Only the existing enabled mapping set is eligible. Account number, display name
// and property payment instructions NEVER establish identity or get rewritten.
async function getCatalog(pool, orgId, options = {}) {
  const bound = await binding(pool, orgId);
  const [rows] = await pool.execute(`SELECT m.xero_account_id,m.xero_account_name,m.tenafy_account_setting_id,m.bank_account_id,
      a.name AS ledger_name,CAST(a.enabled AS UNSIGNED) AS ledger_enabled,b.id AS active_bank_id,b.currency AS configured_currency
    FROM xero_account_map m JOIN account_setting a ON a.id=m.tenafy_account_setting_id AND a.org_id=m.org_id
    LEFT JOIN bank_account b ON b.id=m.bank_account_id AND b.org_id=m.org_id AND b.status=1 AND b.deleted_at IS NULL
    WHERE m.org_id=? AND m.ignored=0 ORDER BY m.xero_account_name`, [orgId]);
  let remote;
  try { remote = await deadline(metadata(pool, orgId, bound.xero_tenant_id, options), options.timeoutMs ?? 8000); }
  catch (error) { if (error.bankCatalogError) throw error; fail('Could not verify Xero bank currencies. Retry shortly.', 503); }
  const counts = new Map(), ledgerCounts = new Map();
  for (const row of rows) { const id=normal(row.xero_account_id); if(id) counts.set(id,(counts.get(id)||0)+1); const ledger=String(row.tenafy_account_setting_id); ledgerCounts.set(ledger,(ledgerCounts.get(ledger)||0)+1); }
  const accounts = [], unavailable = [];
  for (const row of rows) {
    const id = normal(row.xero_account_id), matches = remote.accounts.filter(a => normal(a.AccountID) === id);
    const account = matches.length === 1 ? matches[0] : null;
    const currency = account?.CurrencyCode;
    let reason;
    if (!id || counts.get(id) !== 1) reason = 'Mapping is invalid or duplicated.';
    else if (ledgerCounts.get(String(row.tenafy_account_setting_id)) !== 1) reason = 'Several enabled Xero banks share one ledger; bank identity needs review.';
    else if (row.bank_account_id != null && (row.active_bank_id == null || String(row.configured_currency || '').trim().toUpperCase() !== currency)) reason = 'Existing bank record is inactive or has conflicting currency.';
    else if (Number(row.ledger_enabled) !== 1) reason = 'Tenafy ledger account is disabled.';
    else if (!account || account.Type !== 'BANK' || account.Status !== 'ACTIVE') reason = 'Xero bank account is missing, inactive or ambiguous.';
    else if (!Intl.supportedValuesOf('currency').includes(currency) || new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits > 2) reason = 'Bank currency needs review.';
    if (reason) { unavailable.push({xero_account_id:id,name:row.xero_account_name,reason}); continue; }
    accounts.push({ xero_account_id:id, name:account.Name, currency,
      account_setting_id:String(row.tenafy_account_setting_id), bank_account_id:row.bank_account_id == null ? null : String(row.bank_account_id) });
  }
  return { org_id:String(orgId), ui_org_slug:bound.ui_org_slug, accounts, unavailable,
    verified_at:remote.verified_at, read_only:true };
}
module.exports = { getCatalog };

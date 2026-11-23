const { traceAmounts } = require('./paymentMatchService');
const { personOrCompanyName } = require('../utils/personName');
const history = require('./switchboardHistorySearch');
const bankCatalog = require('./xeroBankCatalog');
const identity = require('../utils/xeroStatementIdentity');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function normalizeAccountId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('A valid Xero bank-account ID is required.');
  return value.replace(/-/g, '').toLowerCase();
}
function slug(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('A verified Xero UI organisation slug is required.');
  return value;
}
function currencyDigits(code) {
  if (!Intl.supportedValuesOf('currency').includes(code)) fail('Unsupported currency.');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  // Tenafy's existing ledger stores amounts at two decimal places.
  if (digits > 2) fail('This currency needs more decimal places than the Tenafy ledger supports.');
  return digits;
}
function decimalMinor(value, digits) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.slice(digits) || '').replace(/0/g, '')) return null;
  const n = BigInt(match[1]) * (10n ** BigInt(digits)) + BigInt((match[2] || '').slice(0, digits).padEnd(digits, '0') || '0');
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
function validateStatement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('statement is required.');
  const { id_suffix, date, direction, currency, amount_minor } = input;
  if (typeof id_suffix !== 'string' || !/^[0-9a-f]{32}$/i.test(id_suffix)) fail('A statement-line suffix is required.');
  const dateValue = typeof date === 'string' ? new Date(date + 'T00:00:00Z') : new Date(NaN);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date) fail('Use a valid YYYY-MM-DD statement date.');
  if (!['received', 'spent'].includes(direction)) fail('direction must be received or spent.');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) fail('An explicit currency code is required.');
  const digits = currencyDigits(currency);
  if (!Number.isSafeInteger(amount_minor) || amount_minor <= 0 || amount_minor > 99999999999999) fail('amount_minor must be a positive, bounded integer.');
  const text = key => {
    if (input[key] == null) return '';
    if (typeof input[key] !== 'string' || input[key].length > 1000) fail(`${key} must be text of at most 1000 characters.`);
    return input[key].trim();
  };
  if(input.identity_incomplete != null && typeof input.identity_incomplete !== 'boolean') fail('identity_incomplete must be boolean.');
  const base = String(amount_minor).padStart(digits + 1, '0');
  const amount = digits ? base.slice(0, -digits) + '.' + base.slice(-digits) : base;
  return { id_suffix: id_suffix.toLowerCase(), date, direction, currency, amount_minor, amount, digits,
    reference: text('reference'), description: text('description'), payee: text('payee'), identity_incomplete:input.identity_incomplete===true };
}

async function resolveMapping(pool, orgId, uiSlug, accountId, statement, options = {}) {
  const [[binding]] = await pool.execute(`SELECT b.ui_org_slug, b.xero_tenant_id, c.xero_tenant_id AS connected_tenant_id
    FROM xero_browser_binding b JOIN xero_connection c ON c.org_id=b.org_id WHERE b.org_id=?`, [orgId]);
  if (!binding || binding.ui_org_slug !== uiSlug || binding.xero_tenant_id !== binding.connected_tenant_id) fail('Xero UI organisation mapping is missing or no longer matches the connection.', 409);
  const [maps] = await pool.execute(`SELECT m.id, m.tenafy_account_setting_id, m.bank_account_id, ba.currency
    FROM xero_account_map m
    LEFT JOIN bank_account ba ON ba.id=m.bank_account_id AND ba.org_id=m.org_id AND ba.deleted_at IS NULL AND ba.status=1
    JOIN account_setting ac ON ac.id=m.tenafy_account_setting_id AND ac.org_id=m.org_id AND ac.enabled=b'1'
    WHERE m.org_id=? AND m.ignored=0 AND (m.bank_account_id IS NULL OR ba.id IS NOT NULL) AND LOWER(REPLACE(m.xero_account_id,'-',''))=?`, [orgId, accountId]);
  if (maps.length !== 1) fail('Configure one active, unambiguous Xero bank-account mapping first.', 409);
  const mapping = maps[0];
  if (mapping.bank_account_id == null) {
    const catalogue = await (options.getCatalog || bankCatalog.getCatalog)(pool, orgId);
    const account = catalogue.accounts.find(a => a.xero_account_id === accountId);
    if (catalogue.org_id !== String(orgId) || catalogue.ui_org_slug !== uiSlug || !account || account.account_setting_id !== String(mapping.tenafy_account_setting_id)) fail('Bank catalogue no longer agrees with the enabled ledger mapping.', 409);
    mapping.currency = account.currency;
  }
  if (String(mapping.currency || '').trim().toUpperCase() !== statement.currency) fail('Statement currency does not match the configured bank currency.', 409);
  const [currencies] = await pool.execute(`SELECT c.id,c.detail,b.currency_code AS bound_currency_code
    FROM currency c LEFT JOIN xero_browser_currency_binding b ON b.org_id=c.org_id AND b.currency_id=c.id
    WHERE c.org_id=?`, [orgId]);
  const matches = currencies.filter(c => {
    try {
      const detail = typeof c.detail === 'string' ? JSON.parse(c.detail) : c.detail;
      if (detail?.code && c.bound_currency_code && detail.code !== c.bound_currency_code) return false;
      return (detail?.code || c.bound_currency_code) === statement.currency;
    }
    catch { return false; }
  });
  if (matches.length !== 1) fail('Configure one unambiguous Tenafy currency record for this bank.', 409);
  return { ...mapping, currency_id: String(matches[0].id), bank_account_id: mapping.bank_account_id == null ? null : String(mapping.bank_account_id), xero_account_id: accountId,
    account_setting_id: String(mapping.tenafy_account_setting_id) };
}

function sourcesFor(mapping, statement) {
  const { bank_account_id: bank, account_setting_id: account, currency_id: currency } = mapping;
  const propertyScope = bank != null ? 'p.bank_account_id=?' : `EXISTS (SELECT 1 FROM accounting bank_history
    WHERE bank_history.org_id=p.org_id AND bank_history.property_id=p.id AND bank_history.deleted_at IS NULL
      AND bank_history.account_setting_id=? AND UPPER(TRIM(bank_history.currency_type))=?)`;
  const propertyParams = bank != null ? [bank] : [account, statement.currency];
  const policy = identity.identityFor(statement);
  const names = identity.tenantNameColumns();
  const paid = `(SELECT COALESCE(SUM(al.amount),0) FROM accounting_line al
    JOIN accounting a ON a.id=al.accounting_id AND a.org_id=i.org_id AND a.deleted_at IS NULL
    WHERE al.invoice_code=i.invoice_code AND al.deleted_at IS NULL)`;
  return {
    async fetchInvoices(pool, orgId, row) {
      const gate = identity.identitySql(policy,{names,references:['i.invoice_code']});
      const [rows] = await pool.execute(`SELECT i.id, i.invoice_code, i.amount, i.amount-${paid} AS outstanding,
        DATE_FORMAT(i.due_on,'%Y-%m-%d') AS due_on, DATEDIFF(i.due_on,?) AS days_from_date,
        t.first_name,t.middle_name,t.last_name,t.company_name,t.type, u.name AS unit_name,
        p.display_name AS property_name, c.name AS category
        FROM invoice i
        JOIN property p ON p.id=i.property_id AND p.org_id=i.org_id AND p.deleted_at IS NULL AND ${propertyScope}
        LEFT JOIN unit u ON u.id=i.unit_id AND u.property_id=p.id
        LEFT JOIN tenant t ON t.id=i.tenant_id AND t.org_id=i.org_id AND t.deleted_at IS NULL
        LEFT JOIN category_setting c ON c.id=i.category AND c.org_id=i.org_id
        WHERE i.org_id=? AND i.deleted_at IS NULL AND i.status IN (0,2) AND i.currency_id=? AND i.type=? AND i.amount=?
          AND NOT EXISTS (SELECT 1 FROM accounting_line other_line
            JOIN accounting other_payment ON other_payment.id=other_line.accounting_id
              AND other_payment.org_id=i.org_id AND other_payment.deleted_at IS NULL
            WHERE other_line.invoice_code=i.invoice_code AND other_line.deleted_at IS NULL
              AND (other_payment.currency_id IS NULL OR other_payment.currency_id<>i.currency_id
                OR other_payment.currency_type IS NULL OR UPPER(TRIM(other_payment.currency_type))<>?))
          AND ${gate.sql}
        HAVING outstanding>=? ORDER BY ABS(days_from_date),i.id LIMIT 10`,
      [row.date, ...propertyParams, orgId, currency, row.direction === 'received' ? 0 : 1, statement.amount, statement.currency, ...gate.params, statement.amount]);
      return rows.map(r => ({ _identity_names:identity.candidateNames(r), id: String(r.id), code: r.invoice_code, amount: Number(r.amount),
        outstanding_minor: decimalMinor(r.outstanding, statement.digits), due_on: r.due_on,
        tenant_name: personOrCompanyName(r) || null, unit_name: r.unit_name, property_name: r.property_name,
        category: r.category, days_from_date: r.days_from_date }));
    },
    async fetchLeases(pool, orgId, row) {
      const spent = row.direction === 'spent';
      const gate = identity.identitySql(policy,{names,references:['l.lease_no']});
      const [rows] = await pool.execute(`SELECT l.id,l.lease_no,l.amount,l.price,l.deposit,
        t.first_name,t.middle_name,t.last_name,t.company_name,t.type,u.name AS unit_name
        FROM leasing l JOIN unit u ON u.id=l.unit_id
        JOIN property p ON p.id=u.property_id AND p.org_id=? AND p.deleted_at IS NULL AND ${propertyScope}
        LEFT JOIN tenant t ON t.id=l.tenant_id AND t.org_id=p.org_id AND t.deleted_at IS NULL
        WHERE l.deleted_at IS NULL AND l.currency_id=? AND ${spent ? 'l.deposit=?' : '(l.amount=? OR l.price=? OR l.deposit=?)'}
          AND ${gate.sql}
        ORDER BY ABS(DATEDIFF(l.start_date,?)),l.id LIMIT 10`,
      [orgId, ...propertyParams, currency, statement.amount, ...(!spent ? [statement.amount, statement.amount] : []), ...gate.params, row.date]);
      return rows.map(r => ({ _identity_names:identity.candidateNames(r), id: String(r.id), lease_no: r.lease_no, tenant_name: personOrCompanyName(r) || null,
        unit_name: r.unit_name, matched_field: Number(r.deposit) === row.amount ? 'deposit' : 'rent' }));
    },
    async fetchAccounting(pool, orgId, row) {
      const gate = identity.identitySql(policy,{names,references:['a.transaction_code','a.xero_transaction_id','a.note']});
      const [rows] = await pool.execute(`SELECT a.id,a.xero_transaction_id,a.transaction_code,a.note,
        DATE_FORMAT(a.payment_date,'%Y-%m-%d') AS payment_date,
        t.first_name,t.middle_name,t.last_name,t.company_name,t.type,c.name AS category
        FROM accounting a
        JOIN property p ON p.id=a.property_id AND p.org_id=a.org_id AND p.deleted_at IS NULL ${bank != null ? 'AND p.bank_account_id=?' : ''}
        LEFT JOIN tenant t ON t.id=a.tenant_id AND t.org_id=a.org_id AND t.deleted_at IS NULL
        LEFT JOIN category_setting c ON c.id=a.category AND c.org_id=a.org_id
        WHERE a.org_id=? AND a.deleted_at IS NULL AND a.account_setting_id=? AND a.currency_id=?
          AND UPPER(TRIM(a.currency_type))=? AND a.type=? AND a.amount=? AND ${gate.sql}
        ORDER BY ABS(DATEDIFF(a.payment_date,?)),a.id LIMIT 10`,
      [...(bank != null ? [bank] : []), orgId, account, currency, statement.currency, row.direction === 'received' ? 0 : 1, statement.amount, ...gate.params, row.date]);
      return rows.map(r => ({ _identity_names:identity.candidateNames(r), _identity_reference:r.note, id: String(r.id), xero_transaction_id: r.xero_transaction_id || null,
        transaction_code: r.transaction_code, payment_date: r.payment_date, category: r.category,
        tenant_name: personOrCompanyName(r) || null, note: String(r.note || '').slice(0, 300) }));
    },
  };
}

async function copiedEvidence(pool, orgId, mapping, statement, options = {}) {
  return history.searchStoredHistory(pool, orgId, mapping, statement, options);
}

async function historyScope(options) {
  return options.getHistoryScope ? options.getHistoryScope() : { allowUnlinked: false, verification: 'linked_records_only' };
}

async function searchHistory(pool, orgId, body, options = {}) {
  if (body?.expected_org_id != null) {
    if (typeof body.expected_org_id !== 'string' || !/^\d{1,20}$/.test(body.expected_org_id)) fail('expected_org_id must be an organisation ID string.');
    if (body.expected_org_id !== String(orgId)) fail('The signed-in Tenafy organisation changed. Reconnect before searching.', 409);
  }
  const uiSlug = slug(body?.ui_org_slug), accountId = normalizeAccountId(body?.xero_account_id);
  const statement = validateStatement(body?.statement);
  const mapping = await resolveMapping(pool, orgId, uiSlug, accountId, statement, options);
  const evidence = await copiedEvidence(pool, orgId, mapping, statement, { scope: await historyScope(options), cursor: body?.cursor, lookbackDays: body?.lookback_days });
  return envelope(orgId, uiSlug, accountId, mapping, statement, { candidates: [], evidence, status: 'evidence', source_status: {} });
}

async function lookup(pool, orgId, body, options = {}) {
  if (body?.expected_org_id != null) {
    if (typeof body.expected_org_id !== 'string' || !/^\d{1,20}$/.test(body.expected_org_id)) fail('expected_org_id must be an organisation ID string.');
    if (body.expected_org_id !== String(orgId)) fail('The signed-in Tenafy organisation changed. Reconnect before looking up payments.', 409);
  }
  const uiSlug = slug(body?.ui_org_slug), accountId = normalizeAccountId(body?.xero_account_id);
  const statement = validateStatement(body?.statement);
  const mapping = await resolveMapping(pool, orgId, uiSlug, accountId, statement, options);
  const [traced, evidence, slips] = await Promise.all([
    traceAmounts({ pool, orgId, taneChat: null }, [{ amount: Number(statement.amount), date: statement.date, direction: statement.direction }],
      { sources: sourcesFor(mapping, statement) }),
    historyScope(options).then(scope => copiedEvidence(pool, orgId, mapping, statement, { scope })).catch(() => ({ hits: [], unavailable: true, search_scope: 'retained_tenafy_history' })),
    options.findSlips?.(mapping,statement).then(items => ({ items })).catch(() => ({ unavailable: true, items: [] })),
  ]);
  const trace = traced.rows[0];
  const policy = identity.identityFor(statement);
  const candidates = [
    ...trace.invoices.map(c => ({ ...c, kind: 'invoice', review_path: 'create_review' })),
    ...trace.leases.map(c => ({ ...c, kind: 'lease', review_path: 'staff_review' })),
    ...trace.accounting.map(c => ({ ...c, kind: 'accounting', review_path: c.xero_transaction_id ? 'find_and_match_review' : 'staff_review' })),
  ].filter(c=>identity.matchesCandidate(policy,c)).map(c=>{
    const {_identity_names,_identity_reference,...publicCandidate}=c;
    return {...publicCandidate,match_basis:policy.mode,reasons:[...c.reasons,...(policy.payee?['payer/payee name matches']:[]),...(policy.references.length?['reference matches']:[])]};
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const failures = Object.values(trace.errors).filter(Boolean).length;
  return envelope(orgId, uiSlug, accountId, mapping, statement, { candidates, evidence, ...(slips ? { slips } : {}), matching:{mode:policy.mode,payee:policy.payee,references:policy.references,amount_only_fallback:policy.mode==='amount_only'},
    status: failures === 3 ? 'unavailable' : failures ? 'partial' : candidates.length ? 'leads' : policy.mode !== 'amount_only' ? 'no_identity_match' : 'no_financial_lead',
    source_status: Object.fromEntries(Object.entries(trace.errors).map(([k, v]) => [k, v ? 'unavailable' : 'ok'])) });
}

function envelope(orgId, uiSlug, accountId, mapping, statement, result) {
  const issued = new Date();
  return {
    version: 1, proposal_key: `${orgId}:${accountId}:${statement.id_suffix}`,
    issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 5 * 60000).toISOString(),
    identity: { org_id: String(orgId), ui_org_slug: uiSlug, xero_account_id: accountId, bank_account_id: mapping.bank_account_id,
      currency_id: mapping.currency_id, account_setting_id: mapping.account_setting_id, bank_scope: mapping.bank_account_id == null ? 'ledger_history' : 'property_bank', statement: { id_suffix: statement.id_suffix, date: statement.date,
        direction: statement.direction, currency: statement.currency, amount_minor: statement.amount_minor, payee:statement.payee, reference:statement.reference, description:statement.description, identity_incomplete:statement.identity_incomplete } },
    ...result, ambiguity: result.candidates.length > 1,
    capabilities: { read_only: true, live_autofill: false, final_confirmation: 'staff' },
    notices: ['Scores rank leads; they are not probabilities or payment confirmation.',
      'Financial leads still require exact gross amounts in the mapped bank/currency; split and partial payments need review.',
      'Stored Switchboard text is searched in a six-day window ending on the bank date, expandable to thirty days or explicitly to all retained history, across authorised conversations.',
      'Switchboard history covers copied text. Imported and verified payment slips are shown separately when available.',
      'Messages are evidence to review, not payment or currency confirmation.',
      'Accounting history with missing or conflicting currency_type is excluded.',
      'Account/category, tracking and tax autofill mappings are not enabled.'],
  };
}

module.exports = { lookup, normalizeAccountId, validateStatement, decimalMinor, sourcesFor, copiedEvidence, searchHistory, slug, currencyDigits, resolveMapping };

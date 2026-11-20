// Search only the external-channel text retained in Tenafy. No Switchboard
// network calls, OCR, financial writes or AI execution of message contents.
const crypto = require('crypto');
const config = require('../config');
const identity = require('../utils/xeroStatementIdentity');
const PAGE_SIZE = 10;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function decimalParts(minor, digits, scale = 1n) {
  const denominator = (10n ** BigInt(digits)) * scale;
  const whole = BigInt(minor) / denominator;
  let rest = BigInt(minor) % denominator;
  let fraction = '';
  while (rest) { rest *= 10n; fraction += String(rest / denominator); rest %= denominator; }
  return { whole: String(whole), fraction };
}
function amountPattern(statement) {
  const { whole, fraction } = decimalParts(statement.amount_minor, statement.digits);
  const grouped = whole.length > 3 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, '[,[:space:]\u00a0\u202f]') : whole;
  const integer = grouped === whole ? whole : `(?:${whole}|${grouped})`;
  const decimal = fraction ? `\\.${fraction}0*` : '(?:\\.0+)?';
  const compact = decimalParts(statement.amount_minor, statement.digits, 1000n);
  const compactDecimal = compact.fraction ? `\\.${compact.fraction}0*` : '(?:\\.0+)?';
  return `(?<![[:alnum:]_.,])(?:(?:HKD|USD|RMB|CNY|GBP|EUR|CAD|AUD|SGD|JPY|PHP|HK\\$)[[:space:]]*)?(?:${integer}${decimal}|${compact.whole}${compactDecimal}k)(?![[:alnum:]_]|[.,][0-9])`;
}
function referencePattern(statement) {
  const ref = String(statement.reference || '').replace(/[^A-Za-z0-9]/g, '');
  if (ref.length < 6 || ref.length > 64 || !/[0-9]/.test(ref)) return null;
  return `(?<![[:alnum:]_])${ref.split('').map(escapeRegex).join('[[:space:]-]*')}(?![[:alnum:]_])`;
}

// New chat tables are scoped by the org database (unlike legacy core tables).
// Unlinked sessions are admitted only after checking that the registry has one
// owner for that database, the selected pool really is that database, and no
// conversation has an explicit tenant/inquiry link into another organisation.
// Otherwise search is restricted to positively owned contact/inquiry sessions.
async function resolveHistoryScope(pool, orgId, master) {
  try {
    const [[org]] = await master.execute('SELECT id,db_name FROM organizations WHERE id=? AND status=1', [orgId]);
    const [[database]] = await pool.execute('SELECT DATABASE() AS database_name');
    if (!org || database?.database_name !== org.db_name) return { allowUnlinked: false, verification: 'unverified_database' };
    const [owners] = await master.execute('SELECT id FROM organizations WHERE db_name=?', [org.db_name]);
    if (owners.length !== 1 || String(owners[0].id) !== String(orgId)) return { allowUnlinked: false, verification: 'shared_database' };
    const [[conflicts]] = await pool.execute(`SELECT COUNT(*) AS n FROM chat_session s
      LEFT JOIN tenant t ON t.id=s.contact_id LEFT JOIN inquiry q ON q.id=s.inquiry_id
      WHERE s.channel IN ('whatsapp','email') AND
        ((t.id IS NOT NULL AND t.org_id<>?) OR (q.id IS NOT NULL AND q.org_id<>?))`, [orgId, orgId]);
    return Number(conflicts.n) === 0
      ? { allowUnlinked: true, verification: 'dedicated_org_database' }
      : { allowUnlinked: false, verification: 'conflicting_session_links' };
  } catch { return { allowUnlinked: false, verification: 'scope_verification_unavailable' }; }
}

function ownership(orgId, scope) {
  return {
    sql: `s.channel IN ('whatsapp','email')
      AND (t.id IS NULL OR t.org_id=?) AND (q.id IS NULL OR q.org_id=?)
      AND (t.org_id=? OR q.org_id=? OR (?=1 AND s.contact_id IS NULL AND s.inquiry_id IS NULL))`,
    params: [orgId, orgId, orgId, orgId, scope.allowUnlinked === true ? 1 : 0],
  };
}
function messageWindow(statement, days = 6) {
  if (![6, 30, 'all'].includes(days)) throw Object.assign(new Error('Message search supports only 6 days, 30 days or all history.'), { status: 400 });
  if (days === 'all') return { days, start: null, end: null, end_exclusive: null };
  // Calendar-day window ending on the bank date, inclusive. No future messages.
  const end = new Date(statement.date + 'T00:00:00Z');
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  const exclusive = new Date(end); exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  return { days, start: start.toISOString().slice(0,10), end: statement.date, end_exclusive: exclusive.toISOString().slice(0,10) };
}
const timeFilter = window => window.days === 'all' ? '' : ' AND m.created_at>=? AND m.created_at<?';
const timeParams = window => window.days === 'all' ? [] : [window.start, window.end_exclusive];
function queryScope(orgId, mapping, statement, lookbackDays = 6) {
  return crypto.createHash('sha256').update(JSON.stringify({ orgId: String(orgId), bank: String(mapping.bank_account_id),
    currencyId: String(mapping.currency_id), ledger:String(mapping.account_setting_id || ''), xeroAccount:String(mapping.xero_account_id || ''), lookbackDays, statement: { id: statement.id_suffix, date: statement.date,
      direction: statement.direction, currency: statement.currency, amount: statement.amount_minor, reference: statement.reference || '', payee:statement.payee||'', description:statement.description||'', identity_incomplete:statement.identity_incomplete===true } })).digest('hex');
}
const signature = raw => crypto.createHmac('sha256', config.jwtSecret).update('history-page:' + raw).digest('base64url');
function encodeCursor(row, scopeHash) {
  const raw = Buffer.from(JSON.stringify({ v: 1, scope: scopeHash, distance: Number(row.distance),
    created: row.created_sql, id: String(row.id), expires: Date.now() + 10 * 60000 })).toString('base64url');
  return raw + '.' + signature(raw);
}
function decodeCursor(value, scopeHash) {
  if (value == null) return null;
  const invalid = () => { throw Object.assign(new Error('Message page is invalid or expired. Refresh the lookup.'), { status: 400 }); };
  if (typeof value !== 'string' || value.length > 1600) return invalid();
  const [raw, mac, extra] = value.split('.');
  if (!raw || !mac || extra) return invalid();
  const expected = signature(raw);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return invalid();
  let cursor; try { cursor = JSON.parse(Buffer.from(raw, 'base64url').toString()); } catch { return invalid(); }
  if (cursor.v !== 1 || cursor.scope !== scopeHash || !Number.isFinite(cursor.expires) || cursor.expires <= Date.now() ||
      !Number.isSafeInteger(cursor.distance) || cursor.distance < 0 || cursor.distance > 400000000000 ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cursor.created || '') || !/^\d{1,20}$/.test(cursor.id || '')) return invalid();
  return cursor;
}

function formatHit(row, statement) {
  const name = String(row.viewer_name || '').trim();
  const phone = row.viewer_phone || (row.channel === 'whatsapp' ? row.channel_user_id : null);
  const email = row.viewer_email || (row.channel === 'email' ? row.channel_user_id : null);
  return { message_id: String(row.id), session_id: String(row.session_id), timestamp: row.timestamp,
    channel: row.channel, role: row.role, snippet: String(row.snippet || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 700),
    source: 'copied_switchboard', currency_verified: false, days_from_statement: Math.floor(Number(row.distance) / 86400),
    contact: { name: name || null, phone: phone || null, email: email || null,
      tenant_id: row.contact_id == null ? null : String(row.contact_id), inquiry_id: row.inquiry_id == null ? null : String(row.inquiry_id) },
    reasons: [Number(row.amount_match) === 1 ? 'amount mentioned' : null, Number(row.reference_match) === 1 ? 'reference mentioned' : null,
      /\b(paid|payment|transfer(?:red)?|deposit|refund|reimburse|receipt|sent)\b|轉帳|转账|已付|匯款|汇款|入數|入数/i.test(row.snippet || '') ? 'payment wording' : null].filter(Boolean),
    context: [], context_unavailable: false,
  };
}

async function nearby(pool, orgId, scope, hit, row, window) {
  const owned = ownership(orgId, scope);
  const fetchSide = async before => {
    const op = before ? '<' : '>', order = before ? 'DESC' : 'ASC';
    const [rows] = await pool.execute(`SELECT /*+ MAX_EXECUTION_TIME(1200) */ m.id,m.role,
      LEFT(m.content,300) AS snippet,DATE_FORMAT(m.created_at,'%Y-%m-%dT%H:%i:%sZ') AS timestamp
      FROM chat_message m JOIN chat_session s ON s.id=m.session_id
      LEFT JOIN tenant t ON t.id=s.contact_id LEFT JOIN inquiry q ON q.id=s.inquiry_id
      WHERE ${owned.sql} AND m.role IN ('user','assistant') AND m.session_id=?
        ${timeFilter(window)}
        AND (m.created_at ${op} ? OR (m.created_at=? AND m.id ${op} ?))
      ORDER BY m.created_at ${order},m.id ${order} LIMIT 1`,
    [...owned.params, hit.session_id, ...timeParams(window), row.created_sql, row.created_sql, hit.message_id]);
    return rows.map(r => ({ message_id: String(r.id), role: r.role, timestamp: r.timestamp, snippet: String(r.snippet || '').slice(0, 300) }));
  };
  try {
    const [before, after] = await Promise.all([fetchSide(true), fetchSide(false)]);
    hit.context = [...before, ...after];
  } catch { hit.context_unavailable = true; }
}

async function searchStoredHistory(pool, orgId, mapping, statement, options = {}) {
  const scope = options.scope || { allowUnlinked: false, verification: 'linked_records_only' };
  const window = messageWindow(statement, options.lookbackDays ?? 6);
  const owned = ownership(orgId, scope), hash = queryScope(orgId, mapping, statement, window.days);
  const cursor = decodeCursor(options.cursor, hash);
  const policy=identity.identityFor(statement);
  const gate=identity.identitySql(policy,{names:['s.viewer_name',...identity.tenantNameColumns()],references:['m.content']});
  const amount = amountPattern(statement), reference = policy.reference_pattern || referencePattern(statement);
  const pattern = reference ? `(?:${amount}|${reference})` : amount;
  const distance = 'ABS(TIMESTAMPDIFF(SECOND,m.created_at,?))';
  const cursorSql = cursor ? 'HAVING distance>? OR (distance=? AND (created_sql<? OR (created_sql=? AND cursor_id<?)))' : '';
  const [rows] = await pool.execute(`SELECT /*+ MAX_EXECUTION_TIME(2500) */ m.id,m.id AS cursor_id,m.session_id,m.role,
      DATE_FORMAT(m.created_at,'%Y-%m-%d %H:%i:%s') AS created_sql,
      DATE_FORMAT(m.created_at,'%Y-%m-%dT%H:%i:%sZ') AS timestamp,${distance} AS distance,
      SUBSTRING(m.content,GREATEST(1,REGEXP_INSTR(m.content,?,1,1,0,'i')-120),700) AS snippet,
      REGEXP_LIKE(m.content,?,'i') AS amount_match,${reference ? "REGEXP_LIKE(m.content,?,'i')" : '0'} AS reference_match,
      s.channel,s.channel_user_id,s.viewer_name,s.viewer_phone,s.viewer_email,s.contact_id,s.inquiry_id
    FROM chat_message m JOIN chat_session s ON s.id=m.session_id
    LEFT JOIN tenant t ON t.id=s.contact_id LEFT JOIN inquiry q ON q.id=s.inquiry_id
    WHERE ${owned.sql} AND m.role IN ('user','assistant')${timeFilter(window)} AND REGEXP_LIKE(m.content,?,'i') AND ${gate.sql}
    ${cursorSql} ORDER BY distance ASC,created_sql DESC,m.id DESC LIMIT ${PAGE_SIZE + 1}`,
  [statement.date, pattern, amount, ...(reference ? [reference] : []), ...owned.params, ...timeParams(window), pattern, ...gate.params,
    ...(cursor ? [cursor.distance, cursor.distance, cursor.created, cursor.created, cursor.id] : [])]);
  // Widen once only when the first six-day page has no matching text. Explicit
  // expansion remains available when recent hits exist but none is the right one.
  if (!cursor && !rows.length && window.days === 6) {
    const expanded = await searchStoredHistory(pool, orgId, mapping, statement, { ...options, lookbackDays: 30 });
    return { ...expanded, expanded_from_days: 6 };
  }
  const page = rows.slice(0, PAGE_SIZE), hits = page.map(row => formatHit(row, statement));
  // Bound concurrent context work so a page cannot occupy all pool slots.
  for (let start = 0; start < hits.length; start += 3) {
    await Promise.all(hits.slice(start, start + 3).map((hit, i) => nearby(pool, orgId, scope, hit, page[start + i], window)));
  }
  const [[coverage]] = await pool.execute(`SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) AS messages,
      MIN(m.created_at) AS earliest,MAX(m.created_at) AS latest
    FROM chat_message m JOIN chat_session s ON s.id=m.session_id
    LEFT JOIN tenant t ON t.id=s.contact_id LEFT JOIN inquiry q ON q.id=s.inquiry_id
    WHERE ${owned.sql} AND m.role IN ('user','assistant')${timeFilter(window)}`, [...owned.params, ...timeParams(window)]);
  return { hits, next_cursor: rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1], hash) : null,
    limited: false, linked_contacts_only: !scope.allowUnlinked, search_scope: 'retained_tenafy_history',
    scope_verification: scope.verification, unlinked_included: scope.allowUnlinked === true,
    coverage: { messages: Number(coverage.messages), earliest: coverage.earliest, latest: coverage.latest, date_window: window.days === 'all' ? null : window },
    matching_mode:policy.mode, lookback_days: window.days, attachments_searchable: false, reference_searched: Boolean(reference),
    notices: [window.days === 'all' ? 'All retained authorised history is searched, including messages outside the thirty-day window; results are ordered by proximity to the bank date.' : `Only the ${window.days} calendar days ending on the bank date are searched; results are ordered by proximity to that date.`,
      'Messages are leads, not proof that money moved or that a currency matches. Attachments/slip images are not stored as searchable documents here.',
      ...(scope.allowUnlinked ? [] : ['Unlinked sessions were omitted because exclusive database ownership could not be verified.'])] };
}

module.exports = { searchStoredHistory, resolveHistoryScope, amountPattern, referencePattern, ownership, encodeCursor, decodeCursor, queryScope, messageWindow };

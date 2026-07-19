/**
 * ask_data — read-only NL→SQL execution for the INTERNAL staff assistant.
 *
 * TWO layers of protection, both required:
 *
 *   1. DB level (the real guarantee): the query runs on a pool connected with
 *      SELECT-only MySQL credentials (config.dbReadOnly / DB_RO_USER). Any write
 *      physically fails at the server, regardless of what this file does.
 *
 *   2. App level (this file): validateSelect() rejects anything that isn't a
 *      single read-only SELECT/CTE, and caps the row count. This catches mistakes
 *      early with a clear message instead of a raw MySQL permission error, and
 *      keeps obviously-bad generated SQL from ever reaching the server.
 *
 * Never point runReadOnly() at the read-write pool — that would silently discard
 * layer 1. The caller passes ctx.roPool, which is null when DB_RO_USER is unset.
 */

const MAX_ROWS = 500;

// Verbs/targets that must never appear anywhere in an ask_data query. Checked
// against the whole string (not just the prefix) so a write can't be smuggled
// into a subquery, a UNION arm, or after a valid-looking SELECT.
const FORBIDDEN = new RegExp(
  '\\b(' + [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE',
    'GRANT', 'REVOKE', 'REPLACE', 'MERGE', 'CALL', 'EXECUTE', 'PREPARE',
    'LOCK', 'UNLOCK', 'RENAME', 'LOAD', 'OUTFILE', 'DUMPFILE', 'INFILE',
    'HANDLER', 'INTO\\s+OUTFILE', 'INTO\\s+DUMPFILE',
    'SLEEP', 'BENCHMARK', 'SET',
  ].join('|') + ')\\b',
  'i'
);

// Schema areas that are off-limits even for reads.
const FORBIDDEN_TARGETS = /\b(mysql|information_schema|performance_schema|sys)\s*\./i;

/**
 * Validate a model-generated query and return an execution-ready SQL string.
 * @param {string} raw
 * @returns {{ok:true, sql:string} | {ok:false, reason:string}}
 */
function validateSelect(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'empty or non-string query' };
  }

  // Strip a single trailing semicolon; any remaining one means chained statements.
  let sql = raw.trim().replace(/;\s*$/, '');
  if (sql.includes(';')) {
    return { ok: false, reason: 'multiple statements are not allowed' };
  }

  // Must be a read: a SELECT, or a CTE that feeds one.
  if (!/^\s*(select|with)\b/i.test(sql)) {
    return { ok: false, reason: 'only SELECT queries are allowed' };
  }

  if (FORBIDDEN.test(sql)) {
    return { ok: false, reason: 'query contains a forbidden keyword (writes/DDL are not allowed)' };
  }
  if (FORBIDDEN_TARGETS.test(sql)) {
    return { ok: false, reason: 'querying system schemas is not allowed' };
  }

  // Cap the result size. Only append when the query has no LIMIT of its own.
  if (!/\blimit\b/i.test(sql)) sql = `${sql} LIMIT ${MAX_ROWS}`;

  return { ok: true, sql };
}

/**
 * Execute a validated SELECT on the org's READ-ONLY pool.
 * @param {object|null} roPool  read-only pool (null when DB_RO_USER is unset)
 * @param {string} sql          output of validateSelect().sql
 * @returns {Promise<{columns:string[], rows:object[], row_count:number, sql:string}>}
 */
async function runReadOnly(roPool, sql) {
  if (!roPool) {
    throw new Error('ask_data is not configured on this server (no read-only database user).');
  }
  // .query (not .execute) — ad-hoc SQL has no bind parameters to prepare.
  const [rows, fields] = await roPool.query(sql);
  const capped = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
  return {
    columns: (fields || []).map(f => f.name),
    rows: capped,
    row_count: capped.length,
    sql,
  };
}

module.exports = { validateSelect, runReadOnly, MAX_ROWS };

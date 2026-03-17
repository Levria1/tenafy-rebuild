/**
 * Mapping of sequence keys to the table/column where generated codes live.
 * Used to find the highest existing code and ensure we never go backwards.
 */
const SEQUENCE_TABLE_MAP = {
  invoice_code:     { table: 'invoice',    column: 'invoice_code',    orgColumn: 'org_id', deletedColumn: 'deleted_at' },
  leasing_code:     { table: 'leasing',    column: 'lease_no',        orgColumn: null,      deletedColumn: 'deleted_at' },
  transaction_code: { table: 'accounting', column: 'transaction_code', orgColumn: 'org_id', deletedColumn: 'deleted_at' },
  service_code:     { table: 'service',    column: 'code',            orgColumn: 'org_id', deletedColumn: 'deleted_at' },
};

/**
 * Extract the numeric suffix from a code string.
 * e.g. "TRIV31399" → 31399, "LEA0000002105" → 2105, "INV-1234" → 1234
 */
function extractNumber(code) {
  if (!code) return 0;
  const match = code.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Build a code string from a pattern and a number.
 * Pattern like "TRIV{#,10}" or "LEA{d,yyyyMMdd}{#,10}"
 */
function buildCode(pattern, num) {
  return pattern
    .replace(/\{d,(\w+)\}/g, () => {
      const now = new Date();
      return now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0');
    })
    .replace(/\{#,(\d+)\}/, () => String(num));
}

/**
 * Generate a unique sequential code for any sequence type.
 *
 * @param {object} pool - MySQL pool (req.pool from org middleware)
 * @param {string|number} orgId - Organization ID
 * @param {string} sequenceKey - One of: 'invoice_code', 'leasing_code', 'transaction_code', 'service_code'
 * @returns {Promise<string>} The generated code
 */
async function generateSequenceCode(pool, orgId, sequenceKey) {
  const [[seq]] = await pool.execute(
    'SELECT id, seq_next, pattern FROM sequence WHERE org_id = ? AND `key` = ? FOR UPDATE',
    [orgId, sequenceKey]
  );
  if (!seq) {
    return sequenceKey.toUpperCase().replace('_', '-') + '-' + Date.now();
  }

  const tableInfo = SEQUENCE_TABLE_MAP[sequenceKey];
  let seqNext = Number(seq.seq_next) || 1;

  // Find the highest existing number in the target table
  if (tableInfo) {
    let maxQuery;
    let maxParams;
    if (tableInfo.orgColumn) {
      maxQuery = `SELECT ${tableInfo.column} as code FROM ${tableInfo.table} WHERE ${tableInfo.orgColumn} = ? ORDER BY ${tableInfo.column} DESC LIMIT 1`;
      maxParams = [orgId];
    } else {
      // leasing has no direct org_id — join through unit → property
      maxQuery = `SELECT l.${tableInfo.column} as code FROM ${tableInfo.table} l JOIN unit u ON l.unit_id = u.id JOIN property p ON u.property_id = p.id WHERE p.org_id = ? ORDER BY l.${tableInfo.column} DESC LIMIT 1`;
      maxParams = [orgId];
    }

    try {
      const [rows] = await pool.execute(maxQuery, maxParams);
      if (rows.length > 0 && rows[0].code) {
        const highestNum = extractNumber(rows[0].code);
        if (highestNum >= seqNext) {
          seqNext = highestNum + 1;
        }
      }
    } catch (err) {
      console.warn(`[Sequence] Could not check max for ${sequenceKey}:`, err.message);
    }
  }

  // For invoice codes: also check accounting_line for orphaned references
  if (sequenceKey === 'invoice_code') {
    try {
      const [[maxOrphan]] = await pool.execute(
        `SELECT al.invoice_code as code
         FROM accounting_line al
         JOIN accounting a ON al.accounting_id = a.id
         WHERE a.org_id = ? AND al.invoice_code IS NOT NULL AND al.invoice_code != '' AND a.deleted_at IS NULL
         ORDER BY al.invoice_code DESC LIMIT 1`,
        [orgId]
      );
      if (maxOrphan && maxOrphan.code) {
        const orphanNum = extractNumber(maxOrphan.code);
        if (orphanNum >= seqNext) {
          seqNext = orphanNum + 1;
        }
      }
    } catch (err) {
      console.warn('[Sequence] Could not check accounting_line max:', err.message);
    }
  }

  // Generate the code and check for orphaned accounting_lines (invoice codes only)
  const MAX_SKIP = 20;
  let finalNum = seqNext;

  if (sequenceKey === 'invoice_code') {
    for (let i = 0; i < MAX_SKIP; i++) {
      const candidateCode = buildCode(seq.pattern, finalNum);
      const [[{ orphan_count }]] = await pool.execute(
        `SELECT COUNT(*) as orphan_count FROM accounting_line al
         JOIN accounting a ON al.accounting_id = a.id
         WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
        [candidateCode, orgId]
      );
      if (Number(orphan_count) === 0) break;
      console.warn(`[Sequence] Skipping invoice code ${candidateCode} — has ${orphan_count} orphaned payment(s)`);
      finalNum++;
    }
  }

  const code = buildCode(seq.pattern, finalNum);

  // Update seq_next to finalNum + 1 (always move forward)
  await pool.execute('UPDATE sequence SET seq_next = ? WHERE id = ?', [finalNum + 1, seq.id]);

  return code;
}

// Convenience wrapper for backward compatibility
async function generateInvoiceCode(pool, orgId) {
  return generateSequenceCode(pool, orgId, 'invoice_code');
}

module.exports = { generateSequenceCode, generateInvoiceCode };

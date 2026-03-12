const pool = require('../config/database');

/**
 * Generate a unique invoice_code from the sequence table.
 * Skips codes that already have orphaned accounting_line records (from deleted invoices)
 * to prevent new invoices from inheriting old payments.
 *
 * @param {string|number} orgId - The organization ID
 * @returns {Promise<string>} A safe-to-use invoice code
 */
async function generateInvoiceCode(orgId) {
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [[seq]] = await pool.execute(
      'SELECT id, seq_next, pattern FROM sequence WHERE org_id = ? AND `key` = ? FOR UPDATE',
      [orgId, 'invoice_code']
    );
    if (!seq) return 'INV-' + Date.now() + '-' + Math.floor(Math.random() * 10000);

    const code = seq.pattern
      .replace(/\{d,(\w+)\}/g, () => {
        const now = new Date();
        return now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      })
      .replace(/\{#,(\d+)\}/, () => String(seq.seq_next));
    await pool.execute('UPDATE sequence SET seq_next = seq_next + 1 WHERE id = ?', [seq.id]);

    // Check if this code already has orphaned accounting_line records
    const [[{ orphan_count }]] = await pool.execute(
      `SELECT COUNT(*) as orphan_count FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
      [code, orgId]
    );
    if (Number(orphan_count) === 0) {
      return code; // Safe to use — no orphaned payments
    }
    console.warn(`[Invoice] Skipping code ${code} — has ${orphan_count} orphaned accounting_line(s). Trying next...`);
  }
  // Fallback after max attempts — use timestamp-based code
  return 'INV-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
}

module.exports = { generateInvoiceCode };

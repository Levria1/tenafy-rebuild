// Pure helpers for multi-invoice reconcile allocation. No DB, no Express.

// Returns the single shared invoice_code if EVERY line has the same non-empty
// code; otherwise null (mixed invoices, or any uninvoiced/category-only line).
function resolveHeaderInvoiceCode(lines) {
  const codes = (lines || []).map(l => (l && l.invoice_code) ? String(l.invoice_code) : null);
  if (!codes.length) return null;
  if (codes.some(c => !c)) return null;
  const first = codes[0];
  return codes.every(c => c === first) ? first : null;
}

// Line amounts must sum to the transaction total (±0.01 tolerance).
function validateSplitTotal(lines, total) {
  const sum = (lines || []).reduce((s, l) => s + (Number(l && l.amount) || 0), 0);
  return { ok: Math.abs(sum - (Number(total) || 0)) < 0.01, sum };
}

module.exports = { resolveHeaderInvoiceCode, validateSplitTotal };

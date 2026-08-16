// Recalculate invoice status after payment changes. Finds all invoices linked to
// accounting_lines (and the header) of the given transaction, then updates each
// invoice's status from total payments vs amount vs due date.
// `db` may be a pool or a transaction connection — both expose .execute().
const { orgToday, dbDate } = require('./orgTime');

async function recalcInvoiceStatuses(db, accountingId, orgId) {
  if (!orgId) {
    // Look up org_id from the accounting record itself
    const [[acct]] = await db.execute('SELECT org_id FROM accounting WHERE id = ?', [accountingId]);
    if (!acct) return;
    orgId = acct.org_id;
  }

  // Get all distinct invoice_codes from this transaction's lines
  const [lines] = await db.execute(
    `SELECT DISTINCT al.invoice_code
     FROM accounting_line al
     WHERE al.accounting_id = ? AND al.invoice_code IS NOT NULL AND al.invoice_code != ''`,
    [accountingId]
  );
  // Also check the header's invoice_code
  const [[header]] = await db.execute(
    'SELECT invoice_code FROM accounting WHERE id = ?',
    [accountingId]
  );
  const codes = new Set(lines.map(l => l.invoice_code));
  if (header && header.invoice_code) codes.add(header.invoice_code);

  for (const invoiceCode of codes) {
    // Get the invoice — MUST filter by org_id to prevent cross-org collisions
    const [invoices] = await db.execute(
      'SELECT id, amount, due_on, status FROM invoice WHERE invoice_code = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
      [invoiceCode, orgId]
    );
    if (invoices.length === 0) continue;
    const invoice = invoices[0];

    // Sum all payments for this invoice — MUST filter by org_id
    const [[{ total_paid }]] = await db.execute(
      `SELECT COALESCE(SUM(al.amount), 0) as total_paid
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
      [invoiceCode, orgId]
    );

    const amount = parseFloat(invoice.amount) || 0;
    const paid = parseFloat(total_paid) || 0;
    // dbDate, not toISOString: mysql2 hands back a DATE as LOCAL midnight, so
    // toISOString() would report the previous day anywhere east of UTC.
    const today = orgToday();
    const dueOn = dbDate(invoice.due_on);
    const isPastDue = dueOn && today > dueOn;

    let newStatus;
    // A $0 (or negative) amount means nothing is owed — treat as Paid.
    // Same for invoices fully covered by payments.
    if (amount <= 0 || paid >= amount) {
      newStatus = 1; // Paid
    } else if (isPastDue) {
      newStatus = 2; // Overdue (past due, not fully paid)
    } else {
      newStatus = 0; // Open
    }

    if (Number(invoice.status) !== newStatus) {
      await db.execute('UPDATE invoice SET status = ? WHERE id = ?', [newStatus, invoice.id]);
    }
  }
}

module.exports = { recalcInvoiceStatuses };

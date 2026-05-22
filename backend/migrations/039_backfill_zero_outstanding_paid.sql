-- One-time backfill: any Open (0) or Overdue (2) invoice whose outstanding is
-- already $0 — either because amount <= 0 OR because payments cover it — is
-- flipped to Paid (1).
--
-- This catches:
--   • Invoices manually edited down to $0 amount (previously left as Open/Overdue)
--   • Invoices whose payments equal/exceed the amount but the auto-flip was
--     skipped (older code had an `amount > 0` guard that excluded $0 invoices)
--   • Anything stuck because the scheduler hasn't fired since the bug fix
--
-- Idempotent: re-running this does nothing new since matching rows will already
-- be status = 1.

UPDATE invoice i
SET i.status = 1
WHERE i.status IN (0, 2)
  AND i.deleted_at IS NULL
  AND (
    i.amount <= 0
    OR i.amount <= COALESCE((
      SELECT SUM(al.amount)
      FROM accounting_line al
      JOIN accounting a ON al.accounting_id = a.id
      WHERE al.invoice_code = i.invoice_code
        AND a.org_id = i.org_id
        AND a.deleted_at IS NULL
        AND al.deleted_at IS NULL
    ), 0)
  );

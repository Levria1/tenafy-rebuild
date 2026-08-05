-- 031_invoice_write_off.sql  (PER-ORG)
-- Uncollectable invoices ("written off").
--
-- A tenant who has moved out may leave a balance that is impossible to chase.
-- Such an invoice keeps its row (you can still see it is owed) but must NOT
-- inflate the outstanding-due totals or the aging report.
--
-- This is modelled as a new value of the EXISTING invoice.status tinyint:
--   0 = Open, 1 = Paid, 2 = Overdue, 3 = WRITTEN OFF   (<- new)
-- No schema change is needed for the status itself. Because every
-- outstanding/overdue query in the app filters on status = 0 / = 2 / IN (0,2),
-- a written-off invoice drops out of those totals automatically, while the
-- invoice LIST (which has no default status filter) still shows it.
--
-- These two columns only record WHEN and WHY it was written off.
--
-- Idempotent: information_schema-guarded.

-- 1. invoice.written_off_at
SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'written_off_at');
SET @ddl1 := IF(@c1 = 0,
  'ALTER TABLE invoice ADD COLUMN written_off_at TIMESTAMP NULL DEFAULT NULL',
  'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

-- 2. invoice.written_off_reason
SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'written_off_reason');
SET @ddl2 := IF(@c2 = 0,
  'ALTER TABLE invoice ADD COLUMN written_off_reason VARCHAR(255) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

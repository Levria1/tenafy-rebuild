-- 007_xero_account_ignore.sql
-- Adds a per-account "ignore" flag to xero_account_map so a user can tell the
-- sync engine to skip a Xero bank account entirely (e.g. a personal savings
-- account or a Xero clearing/suspense account). Transactions from an ignored
-- account are dropped at pull time and never enter the review queue — no
-- "Unmapped" clutter to keep skipping.
--
-- Idempotent: guarded by information_schema so re-running is a no-op.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'xero_account_map'
     AND COLUMN_NAME = 'ignored'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE xero_account_map ADD COLUMN ignored TINYINT(1) NOT NULL DEFAULT 0 AFTER tenafy_account_setting_id',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

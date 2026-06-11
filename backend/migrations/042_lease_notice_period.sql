-- 042_lease_notice_period.sql  (MAIN DB)
-- Adds leasing.notice_period_days — the number of days' notice a tenant must
-- give if they intend to renew. Exposed as a template placeholder
-- ({{NOTICE_PERIOD}} in lease docs, %Notice Period - Lease% in emails).
--
-- Idempotent: guarded by information_schema so re-running is a no-op.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'leasing'
     AND COLUMN_NAME = 'notice_period_days'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE leasing ADD COLUMN notice_period_days INT NULL DEFAULT NULL AFTER contract_type',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

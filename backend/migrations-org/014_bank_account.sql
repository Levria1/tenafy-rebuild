-- Per-org migration: structured bank accounts for property/Xero reconciliation.
-- Idempotent: table creation uses IF NOT EXISTS and column/index changes are
-- guarded by information_schema checks so re-running is a no-op.

CREATE TABLE IF NOT EXISTS bank_account (
  id               BIGINT       NOT NULL,
  org_id           BIGINT       NOT NULL,
  label            VARCHAR(120) NOT NULL,
  beneficiary_name VARCHAR(255) DEFAULT NULL,
  bank_name        VARCHAR(120) DEFAULT NULL,
  account_number   VARCHAR(64)  DEFAULT NULL,
  branch_code      VARCHAR(32)  DEFAULT NULL,
  bank_code        VARCHAR(32)  DEFAULT NULL,
  swift            VARCHAR(32)  DEFAULT NULL,
  currency         VARCHAR(8)   DEFAULT NULL,
  notes            TEXT         DEFAULT NULL,
  status           TINYINT      NOT NULL DEFAULT 1,
  deleted_at       TIMESTAMP    NULL DEFAULT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bank_account_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'property' AND COLUMN_NAME = 'bank_account_id');
SET @s = IF(@c = 0,
  'ALTER TABLE property ADD COLUMN bank_account_id BIGINT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'property' AND INDEX_NAME = 'idx_property_bank_account');
SET @s = IF(@c = 0,
  'ALTER TABLE property ADD INDEX idx_property_bank_account (bank_account_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'xero_account_map' AND COLUMN_NAME = 'bank_account_id');
SET @s = IF(@c = 0,
  'ALTER TABLE xero_account_map ADD COLUMN bank_account_id BIGINT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'xero_account_map' AND INDEX_NAME = 'idx_xero_map_bank_account');
SET @s = IF(@c = 0,
  'ALTER TABLE xero_account_map ADD INDEX idx_xero_map_bank_account (bank_account_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Per-org migration: overdue chasing policy (one row per org).
--
-- Until now the weekly overdue sweep had no policy at all, and in practice sent
-- nothing: it filtered `status = 0` while markOverdueInvoicesForOrg flips every
-- past-due unpaid invoice to 2 at 00:05, so by Monday morning nothing matched.
-- Reviving it means it will actually mail tenants, so the behaviour becomes a
-- setting rather than a constant.
--
-- `enabled` defaults to 0 on purpose. This job messages real tenants and the
-- backlog it would chase on first run is years deep, so deploying the code must
-- not switch it on for anyone. Same stance as advertising_setting.renewal_ask_enabled.
--
-- `categories` is a comma-separated list of category_setting ids. NULL means
-- "rent only", resolved at read time, so an org that never opens the screen
-- keeps the sane default without a backfill.
--
-- Idempotent: IF NOT EXISTS, and the invoice ALTER is guarded by information_schema.

CREATE TABLE IF NOT EXISTS chase_setting (
  org_id            BIGINT    NOT NULL,
  enabled           TINYINT   NOT NULL DEFAULT 0,
  categories        TEXT      DEFAULT NULL,
  days_after_due    INT       NOT NULL DEFAULT 0,
  days_after_issue  INT       NOT NULL DEFAULT 7,
  repeat_days       INT       NOT NULL DEFAULT 7,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- repeat_days is per invoice, so the sweep has to remember when it last chased
-- each one. email_log records lease_id but not invoice_id, and a lease can carry
-- several overdue invoices at once, so the lease-level log cannot answer this.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice'
               AND COLUMN_NAME = 'last_chased_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE invoice ADD COLUMN last_chased_at TIMESTAMP NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

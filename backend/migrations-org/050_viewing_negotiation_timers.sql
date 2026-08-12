-- Per-org migration: dedicated viewing negotiation timer and policy snapshot columns.
--
-- These are dedicated columns instead of values derived from updated_at because
-- viewing_negotiation.updated_at is ON UPDATE CURRENT_TIMESTAMP, so any unrelated
-- write resets it. A timer measured from updated_at silently never fires. Migration
-- 045 already had to work around this with:
--   SET reminder_sent_at = NOW(), updated_at = updated_at
-- Every timestamp here is written once, from the moment the thing it names
-- actually happened.
--
-- policy_* is a snapshot: the policy is resolved when the tenant is notified and
-- frozen, so editing the org setting mid-negotiation cannot retroactively move a
-- deadline that has already been quoted to a tenant in writing.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'customer_asked_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN customer_asked_at DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'tenant_notified_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN tenant_notified_at DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'opt_out_deadline_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN opt_out_deadline_at DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'auto_confirmed_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN auto_confirmed_at DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'customer_nudge_count');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN customer_nudge_count TINYINT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'tenant_nudge_count');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN tenant_nudge_count TINYINT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'last_nudge_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN last_nudge_at DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'policy_opt_out_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN policy_opt_out_hours SMALLINT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'policy_explicit_confirm');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN policy_explicit_confirm TINYINT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'policy_source');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN policy_source VARCHAR(24) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'reversal_reason');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN reversal_reason VARCHAR(64) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND INDEX_NAME = 'idx_vn_opt_out_deadline');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD KEY idx_vn_opt_out_deadline (opt_out_deadline_at)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

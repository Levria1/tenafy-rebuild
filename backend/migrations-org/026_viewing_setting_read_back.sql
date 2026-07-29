-- 026_viewing_setting_read_back.sql  (PER-ORG)
-- Viewing Relay Scheduler — read-back reconfirmation toggle.
--
-- When on (default), a time PROPOSAL (prospect propose, prospect counter, or
-- tenant counter) is echoed back to that person ("view <unit> on <time>? reply
-- YES") and we wait for their confirmation BEFORE running the calendar check /
-- messaging the other party — so a mis-parsed time/unit can't reach the tenant.
--
-- Idempotent: information_schema-guarded ALTER.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting' AND COLUMN_NAME = 'read_back');
SET @ddl := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN read_back TINYINT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- viewing_negotiation.pending_datetime — the time awaiting read-back confirmation
-- (kept separate from current_proposed_datetime so the tenant-counter relay still
-- has the prospect's "old time" to quote).
SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'pending_datetime');
SET @ddl2 := IF(@c2 = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN pending_datetime DATETIME NULL DEFAULT NULL AFTER current_proposed_datetime',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

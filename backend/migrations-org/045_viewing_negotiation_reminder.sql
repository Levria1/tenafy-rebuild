-- Per-org migration: mark stale viewing relay reminders.
--
-- The stale reaper runs hourly. Without a marker, a 12-hour reminder would be
-- sent every hour from hour 12 until the 24-hour staff escalation.
--
-- Important: viewing_negotiation.updated_at is ON UPDATE CURRENT_TIMESTAMP.
-- Reminder writes must preserve the stale clock with:
--   SET reminder_sent_at = NOW(), updated_at = updated_at
-- Do not "clean this up" to a plain reminder_sent_at update, or the negotiation
-- will never become 24h stale.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'reminder_sent_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN reminder_sent_at DATETIME NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

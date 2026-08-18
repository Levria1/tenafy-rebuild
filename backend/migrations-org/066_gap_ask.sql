-- Gap ask policy, 2026-08-18.
-- Vacant units now have their own move-in cutoff, and the customer-facing ask is
-- operator-authored instead of hardcoded in the public route.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'vacant_max_move_in_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN vacant_max_move_in_days SMALLINT NOT NULL DEFAULT 30',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_gap_ask_phrase');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_gap_ask_phrase TEXT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE advertising_setting
   SET inquiry_gap_ask_phrase = 'We''re unable to accept a booking that would leave {units} empty for {gap_days} days. Would you be able to move in by {suggested_move_in_date}?'
 WHERE inquiry_gap_ask_phrase IS NULL;

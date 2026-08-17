-- Inquiry booking horizon is separate from advertising windows by operator decision.
-- The gap tolerance for booking acceptance is code-owned band logic, so this migration
-- adds no redundant gap column that could drift from the shared helper.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_booking_horizon_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_booking_horizon_days SMALLINT NOT NULL DEFAULT 60',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_too_far_out_phrase');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_too_far_out_phrase TEXT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- A shorter free window is not worth advertising because the unit is
-- effectively taken; an inquiry wastes both the prospect's and operator's time.
-- This is a setting rather than a constant so it can be tuned without a deploy.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'min_gap_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN min_gap_days SMALLINT NOT NULL DEFAULT 40',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

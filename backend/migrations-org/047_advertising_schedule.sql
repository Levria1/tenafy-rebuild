-- Per-org migration: slot-level posting schedule.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_forum'
     AND COLUMN_NAME = 'is_owned');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_forum ADD COLUMN is_owned TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_forum'
     AND COLUMN_NAME = 'max_per_week');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_forum ADD COLUMN max_per_week SMALLINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE advertising_forum
   SET is_owned = 1
 WHERE is_owned = 0
   AND name IN (
     'No Fee Rental',
     'Hong Kong Apartments - Short term Rentals',
     'Find A Room In Hong Kong'
   );

SET @t := (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_schedule');
SET @s := IF(@t = 0,
  'CREATE TABLE advertising_schedule (
     id BIGINT NOT NULL PRIMARY KEY,
     org_id BIGINT NOT NULL,
     weekday TINYINT NOT NULL,
     slot_kind VARCHAR(10) NOT NULL,
     slot_no SMALLINT NOT NULL,
     position SMALLINT NOT NULL,
     forum_id BIGINT NOT NULL,
     account_id BIGINT NOT NULL,
     status TINYINT NOT NULL DEFAULT 1,
     deleted_at DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY uk_slot_day (org_id, weekday, slot_kind, slot_no),
     KEY idx_day (org_id, weekday, position)
   ) COMMENT = ''Slot rows from the operator sheet. uk_slot_day exists because a slot appears at most once per day; a duplicate would double-post the same property on the same day.''',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Gap settings serve three different decisions:
--   min_gap_days (40): a unit is not worth ADVERTISING if the next tenant
--     arrives within this many days.
--   max_gap_days (10): WARN that the unit would sit empty this long before the
--     prospect moves in; the unit is still offered.
--   hard_max_gap_days (20): do NOT offer the unit at all past this. Exception:
--     tier 1 (already vacant) units are exempt.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'hard_max_gap_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN hard_max_gap_days SMALLINT NOT NULL DEFAULT 20',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'max_gap_days');
SET @s := IF(@c = 1,
  'ALTER TABLE advertising_setting ALTER COLUMN max_gap_days SET DEFAULT 10',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Safe and narrow: max_gap_days has never had a UI, so exactly 14 can only be
-- the old default rather than a deliberate operator choice. Any other value is
-- left alone.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'max_gap_days');
SET @s := IF(@c = 1,
  'UPDATE advertising_setting SET max_gap_days = 10 WHERE max_gap_days = 14',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

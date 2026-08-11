-- NR gets a longer runway because a confirmed departure is certain, whereas
-- MR/MTM/UC may still renew and advertising too early risks marketing a unit
-- that never comes free.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'lead_days_nr');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN lead_days_nr SMALLINT NOT NULL DEFAULT 60',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'lead_days_other');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN lead_days_other SMALLINT NOT NULL DEFAULT 45',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

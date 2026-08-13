-- Inquiry availability windows are now a separate policy from advertising.
-- NULL no longer means anything: there is no fallback left to express, because
-- the two audiences are independent by operator decision.
--
-- Order matters. Backfill before changing the columns to NOT NULL so deploy-day
-- behaviour is identical for existing org rows. Reversing this would set old
-- NULL values to the column defaults and silently change live availability rules.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_min_gap_days');
SET @s := IF(@c = 1,
  'UPDATE advertising_setting SET inquiry_min_gap_days = min_gap_days WHERE inquiry_min_gap_days IS NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_lead_days_nr');
SET @s := IF(@c = 1,
  'UPDATE advertising_setting SET inquiry_lead_days_nr = lead_days_nr WHERE inquiry_lead_days_nr IS NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_lead_days_other');
SET @s := IF(@c = 1,
  'UPDATE advertising_setting SET inquiry_lead_days_other = lead_days_other WHERE inquiry_lead_days_other IS NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @nullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_min_gap_days');
SET @s := IF(@nullable = 'YES',
  'ALTER TABLE advertising_setting MODIFY COLUMN inquiry_min_gap_days SMALLINT NOT NULL DEFAULT 40',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @nullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_lead_days_nr');
SET @s := IF(@nullable = 'YES',
  'ALTER TABLE advertising_setting MODIFY COLUMN inquiry_lead_days_nr SMALLINT NOT NULL DEFAULT 60',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @nullable := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_lead_days_other');
SET @s := IF(@nullable = 'YES',
  'ALTER TABLE advertising_setting MODIFY COLUMN inquiry_lead_days_other SMALLINT NOT NULL DEFAULT 45',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

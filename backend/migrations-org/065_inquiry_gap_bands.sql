-- Booking acceptance and unit search are different policies (hard reject vs
-- metadata flag). Sharing one set of bands would retune both at once, so each
-- audience owns its own three stay-length columns. Defaults match so deploy-day
-- behaviour does not change.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_gap_band_1m_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_gap_band_1m_days SMALLINT NOT NULL DEFAULT 3',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_gap_band_2m_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_gap_band_2m_days SMALLINT NOT NULL DEFAULT 6',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_gap_band_3m_plus_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_gap_band_3m_plus_days SMALLINT NOT NULL DEFAULT 10',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'search_gap_band_1m_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN search_gap_band_1m_days SMALLINT NOT NULL DEFAULT 3',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'search_gap_band_2m_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN search_gap_band_2m_days SMALLINT NOT NULL DEFAULT 6',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'search_gap_band_3m_plus_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN search_gap_band_3m_plus_days SMALLINT NOT NULL DEFAULT 10',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

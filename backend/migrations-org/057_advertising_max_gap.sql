-- Warning threshold, not a cap: exceeding max_gap_days flags a unit as a
-- poor move-in-date fit, but never removes it from vacancy results.
-- min_gap_days stops a vacant unit being marketed when the next tenancy is too
-- close; max_gap_days flags when filling it would leave it empty too long.
-- Together they describe a sensible match window. The 14-day default is
-- deliberately conservative because the consequence is only an advisory flag.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'max_gap_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN max_gap_days SMALLINT NOT NULL DEFAULT 14',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

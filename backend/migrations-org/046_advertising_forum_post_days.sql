-- Per-org migration: add day-based posting schedule to advertising forums.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_forum'
     AND COLUMN_NAME = 'post_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_forum ADD COLUMN post_days VARCHAR(20) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill existing forums so deployment does not leave every group unscheduled.
-- Without this, the posting plan would produce zero forums and a working feature
-- would appear broken until all current forums were configured by hand. Mon-Sat
-- preserves today's behavior while letting the operator narrow each forum later.
UPDATE advertising_forum SET post_days = '1,2,3,4,5,6' WHERE post_days IS NULL;

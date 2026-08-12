-- Per-org migration: widen service.sub_category for issue descriptions.
--
-- In practice this field is a description, not a compact category token: the UI
-- labels it "Issues / Sub-Category" and shows a sentence-style placeholder
-- ("e.g. Leaking faucet, Broken door"). A 50-character column rejects normal
-- maintenance descriptions, so the fix is to widen it rather than truncating
-- user input. The guard is widen-only so re-running this on an already-migrated
-- org cannot shrink data.

SET @len := (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service'
     AND COLUMN_NAME = 'sub_category');
SET @s := IF(@len IS NOT NULL AND @len < 255,
  'ALTER TABLE service MODIFY COLUMN sub_category VARCHAR(255) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

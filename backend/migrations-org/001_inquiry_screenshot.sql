-- Per-org migration: add inquiry.screenshot_url for the OCR/parse flow.
-- Idempotent — column added only if missing.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'inquiry'
            AND COLUMN_NAME = 'screenshot_url');
SET @s = IF(@c = 0,
  'ALTER TABLE inquiry ADD COLUMN screenshot_url VARCHAR(500) DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

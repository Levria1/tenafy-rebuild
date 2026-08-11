-- Per-org migration: store OTA reservation codes on inquiries.
--
-- TaneChat normalises reservation codes to UPPERCASE on write, so duplicate
-- matching is case-insensitive without relying on a particular collation.
-- This is intentionally not UNIQUE: two inquiry rows may carry the same code
-- before staff merge the duplicate delivery.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry'
     AND COLUMN_NAME = 'reservation_code');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry ADD COLUMN reservation_code VARCHAR(32) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry'
     AND INDEX_NAME = 'idx_inquiry_reservation_code');
SET @s := IF(@i = 0,
  'ALTER TABLE inquiry ADD INDEX idx_inquiry_reservation_code (org_id, reservation_code)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

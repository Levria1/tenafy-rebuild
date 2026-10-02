-- NULL means the password has never changed through the new flow, so sessions
-- are not checked. Changes and resets set this timestamp so older tokens are refused.
-- Idempotent: the ADD COLUMN is guarded by information_schema.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user'
               AND COLUMN_NAME = 'password_changed_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE user ADD COLUMN password_changed_at DATETIME NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

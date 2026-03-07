-- Migration 004: Add payment_instructions column to property table
-- Stores free-text payment instructions shown to tenants (e.g. bank account, payment methods)
-- Safe to run if column already exists (checks INFORMATION_SCHEMA first)

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'property'
    AND COLUMN_NAME = 'payment_instructions'
);

SET @query = IF(@col_exists = 0,
  'ALTER TABLE `property` ADD COLUMN `payment_instructions` TEXT DEFAULT NULL AFTER `notes`',
  'SELECT 1'
);

PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

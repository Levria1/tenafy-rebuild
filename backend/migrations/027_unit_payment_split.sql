-- Split payment_information into account_name and bank_details
-- Safe to re-run: uses IF NOT EXISTS checks

SET @dbname = DATABASE();

-- Add account_name column if not exists
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'unit' AND COLUMN_NAME = 'account_name');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE unit ADD COLUMN account_name VARCHAR(255) DEFAULT NULL AFTER wifi_information', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add bank_details column if not exists
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'unit' AND COLUMN_NAME = 'bank_details');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE unit ADD COLUMN bank_details TEXT DEFAULT NULL AFTER account_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Migrate existing payment_information data into bank_details (one-time, only if bank_details is empty)
UPDATE unit SET bank_details = payment_information WHERE payment_information IS NOT NULL AND payment_information != '' AND (bank_details IS NULL OR bank_details = '');

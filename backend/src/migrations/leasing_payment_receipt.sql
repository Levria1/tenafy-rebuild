-- Add payment_receipt toggle to leasing table
-- Safe to re-run: uses IF NOT EXISTS check

SET @dbname = DATABASE();

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'payment_receipt');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN payment_receipt TINYINT(1) DEFAULT 0 AFTER tenant_deposit_posted', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

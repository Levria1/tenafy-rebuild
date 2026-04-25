-- Backfill missing leasing columns referenced by routes/leasing.js INSERT.
-- Several previous migrations lived in backend/src/migrations/ which the
-- migrate runner does NOT read, so these never made it onto org DBs.
-- Idempotent via information_schema checks.

SET @dbname = DATABASE();

-- utility_credit (carry-over utility credits per lease)
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'utility_credit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN utility_credit DECIMAL(10,2) DEFAULT 0.00 AFTER credits', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- check_in_meter
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'check_in_meter');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN check_in_meter DECIMAL(12,2) DEFAULT NULL AFTER utility_credit', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- check_out_meter
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'check_out_meter');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN check_out_meter DECIMAL(12,2) DEFAULT NULL AFTER check_in_meter', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- check_in_meter_updated_at
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'check_in_meter_updated_at');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN check_in_meter_updated_at DATETIME DEFAULT NULL AFTER check_out_meter', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- check_out_meter_updated_at
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'check_out_meter_updated_at');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN check_out_meter_updated_at DATETIME DEFAULT NULL AFTER check_in_meter_updated_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- settlement_notes
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'settlement_notes');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN settlement_notes TEXT DEFAULT NULL AFTER check_out_meter_updated_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- payment_receipt — referenced in INSERT (routes/leasing.js:663), missing on
-- both Alex Kot AND Tane Residence (the migration was in wrong directory).
-- Without this column lease creation 500s on every org.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'payment_receipt');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN payment_receipt TINYINT(1) DEFAULT 0 AFTER tenant_deposit_posted', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- booking_platform_id (some legacy DBs may be missing this)
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'booking_platform_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN booking_platform_id BIGINT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- sales_agent_id (some legacy DBs may be missing this)
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'sales_agent_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE leasing ADD COLUMN sales_agent_id BIGINT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

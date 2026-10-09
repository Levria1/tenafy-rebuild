-- Stamping needs the landlord entity's BR number and an explicit tenant ID type.
-- Idempotent: each ADD COLUMN is guarded by information_schema.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'property'
               AND COLUMN_NAME = 'landlord_br_no');
SET @sql := IF(@col = 0,
  'ALTER TABLE property ADD COLUMN landlord_br_no VARCHAR(32) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant'
               AND COLUMN_NAME = 'id_type');
SET @sql := IF(@col = 0,
  'ALTER TABLE tenant ADD COLUMN id_type VARCHAR(16) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

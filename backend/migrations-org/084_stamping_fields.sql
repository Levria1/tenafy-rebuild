-- Stamping needs an explicit tenant ID type: eTAX asks whether the number is an HKID
-- or a passport, and the free-text id_card cannot say (most recorded numbers are
-- unbracketed and fit both shapes). NULL = not recorded.
-- The landlord's BR number is NOT stored here — it is already printed in each lease
-- template's signature block, and the payload reads it from the exact template
-- version the contract was signed with.
-- Idempotent: the ADD COLUMN is guarded by information_schema.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant'
               AND COLUMN_NAME = 'id_type');
SET @sql := IF(@col = 0,
  'ALTER TABLE tenant ADD COLUMN id_type VARCHAR(16) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

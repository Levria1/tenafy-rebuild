-- Additive only; old PDFs/signature-party rows/templates retain their behaviour.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='signature_party' AND COLUMN_NAME='tenant_id');
SET @sql := IF(@col=0,'ALTER TABLE signature_party ADD COLUMN tenant_id BIGINT NULL DEFAULT NULL','SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lease_template' AND COLUMN_NAME='tenant_layout');
SET @sql := IF(@col=0,'ALTER TABLE lease_template ADD COLUMN tenant_layout JSON NULL','SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lease_template_revision' AND COLUMN_NAME='tenant_layout');
SET @sql := IF(@col=0,'ALTER TABLE lease_template_revision ADD COLUMN tenant_layout JSON NULL','SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

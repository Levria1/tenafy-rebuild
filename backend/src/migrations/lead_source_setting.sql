CREATE TABLE IF NOT EXISTS lead_source_setting (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  org_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_org_enabled (org_id, enabled)
);

-- Add lead_source_id to tenant table (safe re-run)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant' AND COLUMN_NAME = 'lead_source_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `tenant` ADD COLUMN `lead_source_id` BIGINT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

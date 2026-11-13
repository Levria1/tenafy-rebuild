-- Same idempotent schema as migrations/045; required by migrate:orgs.
-- Schema only. No org is opted in and no website data is loaded by this migration.
SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='unit' AND COLUMN_NAME='website_name')=0,
  'ALTER TABLE unit ADD COLUMN website_name VARCHAR(255) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='organization' AND COLUMN_NAME='website_base_url')=0,
  'ALTER TABLE organization ADD COLUMN website_base_url VARCHAR(500) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS unit_website_product (
  org_id BIGINT NOT NULL,
  unit_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  permalink VARCHAR(1000) NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, product_id),
  KEY idx_unit_website_product_unit (org_id, unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

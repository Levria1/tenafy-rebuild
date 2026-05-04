-- Inquiry table — captures leads/prospects without polluting the contacts (tenant) table.
-- A row is promoted to a tenant only when staff explicitly clicks "Create Contact".

CREATE TABLE IF NOT EXISTS inquiry (
  id BIGINT PRIMARY KEY,
  org_id BIGINT NOT NULL,
  inquiry_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lead_source_id BIGINT DEFAULT NULL,
  first_name VARCHAR(255) DEFAULT NULL,
  last_name VARCHAR(255) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  phone VARCHAR(50) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  unit_id BIGINT DEFAULT NULL,
  property_id BIGINT DEFAULT NULL,
  created_by_user_id BIGINT DEFAULT NULL,
  tenant_id BIGINT DEFAULT NULL,
  status TINYINT NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  INDEX idx_org_status (org_id, status, deleted_at),
  INDEX idx_org_email (org_id, email),
  INDEX idx_tenant (tenant_id)
);

-- Link viewing bookings back to the inquiry that produced them (nullable).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE()
                     AND TABLE_NAME = 'viewing_booking'
                     AND COLUMN_NAME = 'inquiry_id');
SET @sql = IF(@col_exists = 0,
              'ALTER TABLE viewing_booking ADD COLUMN inquiry_id BIGINT DEFAULT NULL, ADD INDEX idx_inquiry (inquiry_id)',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

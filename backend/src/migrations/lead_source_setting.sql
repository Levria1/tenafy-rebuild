CREATE TABLE IF NOT EXISTS lead_source_setting (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  org_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_org_enabled (org_id, enabled)
);

-- Add lead_source_id to tenant table
ALTER TABLE tenant ADD COLUMN lead_source_id BIGINT DEFAULT NULL;

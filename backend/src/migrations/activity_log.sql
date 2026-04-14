CREATE TABLE IF NOT EXISTS activity_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  org_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username VARCHAR(255) DEFAULT NULL,
  action ENUM('CREATE', 'UPDATE', 'DELETE') NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(50) DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  details JSON DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org_created (org_id, created_at),
  INDEX idx_user (user_id),
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_action (action)
);

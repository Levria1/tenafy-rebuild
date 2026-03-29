CREATE TABLE IF NOT EXISTS service_activity (
  id BIGINT PRIMARY KEY,
  org_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  status TINYINT DEFAULT NULL,
  activity_date DATETIME DEFAULT NULL,
  note TEXT DEFAULT NULL,
  created_by BIGINT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_service (service_id, org_id)
);

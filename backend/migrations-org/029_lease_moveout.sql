-- 029_lease_moveout.sql  (PER-ORG)
-- Lease move-out requests.
--
-- Staff can record an approved move-out date, including free-text notes for
-- calendar/vacancy hover details. The row snapshots the lease's original
-- end_date before shortening the lease.
--
-- Idempotent: information_schema-guarded.

-- 1. lease_moveout_request
SET @t1 := (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lease_moveout_request');
SET @ddl1 := IF(@t1 = 0, 'CREATE TABLE lease_moveout_request (
  id BIGINT NOT NULL PRIMARY KEY,
  org_id BIGINT NOT NULL,
  leasing_id BIGINT NOT NULL,
  requested_date DATE NOT NULL,
  original_end_date DATE NULL,
  reason TEXT NULL,
  notes TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT ''requested'',
  requested_by BIGINT NULL,
  decided_by BIGINT NULL,
  decided_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_lmr_leasing (leasing_id),
  INDEX idx_lmr_org_status (org_id, status)
)', 'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

-- Manual vacancy overrides let an operator advertise or offer a unit when a
-- tenant may move out early but the lease has not ended and has no new end
-- date. This table never modifies lease or unit data: accounting, viewing and
-- invoicing continue to read the real durable records.
--
-- expires_on is mandatory. An override that cannot lapse becomes a false
-- promise the day the tenant decides to stay, so every operator-authored
-- override must have an explicit lifecycle.
--
-- There is deliberately no UNIQUE index on unit_id. Cleared rows are retained
-- for audit, so a unit can have many rows over time. The application enforces
-- at most one active override per unit.
--
-- lease_id records the active lease at creation time. If the tenancy is renewed,
-- replaced or re-dated later, the application treats the override as stale until
-- the operator reconfirms it.

SET @table_exists := (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manual_vacancy_override');
SET @s := IF(@table_exists = 0,
  'CREATE TABLE manual_vacancy_override (
     id BIGINT NOT NULL,
     org_id BIGINT NOT NULL,
     unit_id BIGINT NOT NULL,
     lease_id BIGINT NULL,
     available_from DATE NOT NULL,
     expires_on DATE NOT NULL,
     advertising_enabled TINYINT(1) NOT NULL DEFAULT 0,
     inquiry_enabled TINYINT(1) NOT NULL DEFAULT 0,
     reason VARCHAR(255) NULL,
     status TINYINT NOT NULL DEFAULT 1,
     created_by BIGINT NULL,
     created_at DATETIME NOT NULL,
     updated_at DATETIME NULL,
     cleared_at DATETIME NULL,
     cleared_by BIGINT NULL,
     PRIMARY KEY (id),
     INDEX idx_manual_vacancy_override_org_status (org_id, status),
     INDEX idx_manual_vacancy_override_unit_status (unit_id, status),
     INDEX idx_manual_vacancy_override_lease (lease_id)
   )',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @lease_col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manual_vacancy_override'
     AND COLUMN_NAME = 'lease_id');
SET @s := IF(@table_exists = 1 AND @lease_col_exists = 0,
  'ALTER TABLE manual_vacancy_override ADD COLUMN lease_id BIGINT NULL AFTER unit_id',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @lease_idx_exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manual_vacancy_override'
     AND INDEX_NAME = 'idx_manual_vacancy_override_lease');
SET @s := IF(@table_exists = 1 AND @lease_idx_exists = 0,
  'ALTER TABLE manual_vacancy_override ADD INDEX idx_manual_vacancy_override_lease (lease_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

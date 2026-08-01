-- 028_viewing_unit_resolution.sql  (PER-ORG)
-- Viewing Relay Scheduler — in-relay unit resolution + reconfirmation.
--
-- A "Schedule Viewing" can now start from raw text ("mongkok 6a") instead of a
-- known unit_id. Tenafy resolves it and, if it isn't a confident single match,
-- reconfirms/disambiguates over new RESOLVE_UNIT / CONFIRM_UNIT states before the
-- day-ask. During that phase the unit/property aren't pinned yet, so:
--   - unit_id / property_id become NULLABLE (set once the prospect confirms/picks)
--   - pending_unit_text : the text being resolved / last confirmed target
--   - pending_unit_id   : the single match awaiting a YES (CONFIRM_UNIT)
--   - unit_candidates   : JSON [{unit_id,label}] offered in RESOLVE_UNIT (maps a
--                         "1"/name pick back to a unit id)
-- RESOLVE_UNIT / CONFIRM_UNIT are new `state` values (state is VARCHAR — no DDL).
--
-- Idempotent: information_schema-guarded.

-- 1. unit_id NOT NULL -> NULLABLE
SET @n := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'unit_id');
SET @ddl := IF(@n = 'NO', 'ALTER TABLE viewing_negotiation MODIFY unit_id BIGINT NULL DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. property_id NOT NULL -> NULLABLE
SET @n2 := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'property_id');
SET @ddl2 := IF(@n2 = 'NO', 'ALTER TABLE viewing_negotiation MODIFY property_id BIGINT NULL DEFAULT NULL', 'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- 3. pending_unit_text
SET @c3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'pending_unit_text');
SET @ddl3 := IF(@c3 = 0, 'ALTER TABLE viewing_negotiation ADD COLUMN pending_unit_text VARCHAR(255) NULL DEFAULT NULL', 'SELECT 1');
PREPARE s3 FROM @ddl3; EXECUTE s3; DEALLOCATE PREPARE s3;

-- 4. pending_unit_id
SET @c4 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'pending_unit_id');
SET @ddl4 := IF(@c4 = 0, 'ALTER TABLE viewing_negotiation ADD COLUMN pending_unit_id BIGINT NULL DEFAULT NULL', 'SELECT 1');
PREPARE s4 FROM @ddl4; EXECUTE s4; DEALLOCATE PREPARE s4;

-- 5. unit_candidates (JSON array as TEXT for broad MySQL compatibility)
SET @c5 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'unit_candidates');
SET @ddl5 := IF(@c5 = 0, 'ALTER TABLE viewing_negotiation ADD COLUMN unit_candidates TEXT NULL DEFAULT NULL', 'SELECT 1');
PREPARE s5 FROM @ddl5; EXECUTE s5; DEALLOCATE PREPARE s5;

-- 6. org_id — self-scoping. Until now the row was org-scoped only through its
--    property (JOIN property WHERE org_id=?). A resolution-phase row has no
--    property yet, so it needs its own org_id to appear on the staff dashboard.
--    Backfill existing rows from their property.
SET @c6 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'org_id');
SET @ddl6 := IF(@c6 = 0, 'ALTER TABLE viewing_negotiation ADD COLUMN org_id BIGINT NULL DEFAULT NULL', 'SELECT 1');
PREPARE s6 FROM @ddl6; EXECUTE s6; DEALLOCATE PREPARE s6;

UPDATE viewing_negotiation n
  JOIN property p ON p.id = n.property_id
   SET n.org_id = p.org_id
 WHERE n.org_id IS NULL;

SET @c7 := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND INDEX_NAME = 'idx_vn_org_state');
SET @ddl7 := IF(@c7 = 0, 'ALTER TABLE viewing_negotiation ADD INDEX idx_vn_org_state (org_id, state)', 'SELECT 1');
PREPARE s7 FROM @ddl7; EXECUTE s7; DEALLOCATE PREPARE s7;

-- 027_viewing_window_gate.sql  (PER-ORG)
-- Viewing Relay Scheduler — window gate + default-on marketability.
--
-- Two concerns were conflated in leasing.viewing_enabled: "is the unit
-- marketable" (should be on for ~everyone) and "should we disturb the current
-- tenant now" (only when their lease ends soon). This migration:
--   1. Flips leasing.viewing_enabled to default ON (new leases are marketable).
--   2. Adds per-status lead windows to viewing_setting: only inside the window
--      do we message the current tenant.
--         - Not Renewing (contract_type 3)  -> lead_days_nr    (default 60)
--         - all other statuses (2,1,4,0)     -> lead_days_other (default 45)
--   3. Adds viewing_negotiation.needs_staff_reason so an out-of-window request
--      that escalates to staff carries its reason ('off_window').
--
-- Idempotent: information_schema-guarded.

-- 1. leasing.viewing_enabled default 0 -> 1, and backfill EXISTING current leases
--    so the "every unit is marketable by default" intent also holds for data that
--    predates this migration (new leases get the default; current ones get set
--    here). Scoped to the active current lease of active units; historical/ended
--    leases are irrelevant to the gate (it only checks a unit's current lease).
--    Idempotent: the runner applies each migration once per org.
ALTER TABLE leasing ALTER COLUMN viewing_enabled SET DEFAULT 1;

UPDATE leasing l
  JOIN unit u ON l.unit_id = u.id
   SET l.viewing_enabled = 1
 WHERE l.viewing_enabled = 0
   AND l.deleted_at IS NULL
   AND u.active_status = 1
   AND l.start_date <= CURDATE()
   AND (l.end_date >= CURDATE() OR l.end_date IS NULL);

-- 2a. viewing_setting.lead_days_nr
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting' AND COLUMN_NAME = 'lead_days_nr');
SET @ddl := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN lead_days_nr INT NOT NULL DEFAULT 60',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 2b. viewing_setting.lead_days_other
SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting' AND COLUMN_NAME = 'lead_days_other');
SET @ddl2 := IF(@c2 = 0,
  'ALTER TABLE viewing_setting ADD COLUMN lead_days_other INT NOT NULL DEFAULT 45',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- 3. viewing_negotiation.needs_staff_reason
SET @c3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation' AND COLUMN_NAME = 'needs_staff_reason');
SET @ddl3 := IF(@c3 = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN needs_staff_reason VARCHAR(32) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE s3 FROM @ddl3; EXECUTE s3; DEALLOCATE PREPARE s3;

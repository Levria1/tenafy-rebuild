-- 010_viewing_request.sql  (PER-ORG)
-- Adds two columns to `leasing` for the "Request Viewing" flow:
--   viewing_enabled       — staff ticked the NR-gated "Request viewings" box; the
--                           unit is open for viewing requests.
--   viewing_requested_at  — when the availability request was first sent to the
--                           tenant (so we only message them once).
--
-- Idempotent: guarded by information_schema so re-running is a no-op.

SET @c1 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'viewing_enabled'
);
SET @ddl1 := IF(@c1 = 0,
  'ALTER TABLE leasing ADD COLUMN viewing_enabled TINYINT NOT NULL DEFAULT 0 AFTER contract_type',
  'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @c2 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'viewing_requested_at'
);
SET @ddl2 := IF(@c2 = 0,
  'ALTER TABLE leasing ADD COLUMN viewing_requested_at DATETIME NULL DEFAULT NULL AFTER viewing_enabled',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

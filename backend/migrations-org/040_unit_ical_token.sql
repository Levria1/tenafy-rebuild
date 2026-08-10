-- Per-org migration: per-unit Airbnb iCal feed tokens.
--
-- The token is ALSO registered in tena_master.viewing_link_registry so an
-- unauthenticated request can resolve the owning org before it can query this
-- org database. This column alone is not sufficient for public feed lookup.

-- unit.ical_token
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unit'
     AND COLUMN_NAME = 'ical_token');
SET @s := IF(@c = 0,
  'ALTER TABLE unit ADD COLUMN ical_token VARCHAR(64) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- uk_unit_ical_token
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unit'
     AND INDEX_NAME = 'uk_unit_ical_token');
SET @s := IF(@i = 0,
  'ALTER TABLE unit ADD UNIQUE INDEX uk_unit_ical_token (ical_token)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

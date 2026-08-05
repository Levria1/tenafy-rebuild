-- 030_lease_stamp_end_date.sql  (PER-ORG)
-- Government Stamp End Date.
--
-- Some tenancies must be STAMPED with the government for a longer term than the
-- tenant actually stays (e.g. a 2-year stamped agreement for a 2-month stay).
-- This column holds that paperwork-only date. It is DOCUMENT-ONLY: it never
-- affects vacancy, invoicing, expiry or the calendar — those all keep using
-- leasing.end_date (the real operational term).
--
-- Set from the e-signature review-and-send screen; surfaced to lease templates
-- as {{STAMP_END_DATE}} / {{STAMP_END_DATE_SHORT}}. When unset, those variables
-- fall back to the conventional default of start_date + 2 years - 1 day.
--
-- Idempotent: information_schema-guarded.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'stamp_end_date');
SET @ddl := IF(@c = 0,
  'ALTER TABLE leasing ADD COLUMN stamp_end_date DATE NULL DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

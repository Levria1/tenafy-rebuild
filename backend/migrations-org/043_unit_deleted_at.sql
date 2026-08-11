-- Per-org migration: converge `unit.deleted_at` across orgs.
--
-- tena_prod_v2 has this column; the org schema template and every org created from
-- it do NOT. That drift is invisible until code touches it, and 16 queries across 9
-- files do -- property listing, iCal feeds, unit search, the chat tools, the viewing
-- relay and its unit resolver -- so those paths throw "Unknown column 'u.deleted_at'"
-- for any template-created org.
--
-- It became urgent because the inquiry facts API now accepts `unit_text` and runs it
-- through the same resolver. A delivery carrying a listing to a template-created org
-- (the TaneChat Test key points at one) would 500, roll back, release the idempotency
-- claim, and retry forever -- the same failure shape as the notes-limit deadlock.
--
-- Additive and NULL by default, so nothing existing is soft-deleted by running it.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unit'
     AND COLUMN_NAME = 'deleted_at');
SET @s := IF(@c = 0,
  'ALTER TABLE unit ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Queries filter `deleted_at IS NULL` alongside org/property predicates, so give the
-- planner an index rather than leaving it to scan.
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unit'
     AND INDEX_NAME = 'idx_unit_deleted_at');
SET @s := IF(@i = 0,
  'ALTER TABLE unit ADD INDEX idx_unit_deleted_at (deleted_at)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

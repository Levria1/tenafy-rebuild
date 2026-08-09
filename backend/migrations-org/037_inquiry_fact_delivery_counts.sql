-- Per-org migration: record how many facts actually landed on each delivery.
--
-- Facts can be dropped for reasons the caller cannot see — a fact already present
-- in notes is not written twice, and a full notes column stops taking them. The
-- response reports facts_applied/facts_skipped, so a REPLAY has to report the same
-- numbers it reported the first time; that needs storing.

-- ── inquiry_fact_delivery.facts_applied ─────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'facts_applied');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN facts_applied SMALLINT NOT NULL DEFAULT 0 AFTER skipped_json',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry_fact_delivery.facts_skipped ─────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'facts_skipped');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN facts_skipped SMALLINT NOT NULL DEFAULT 0 AFTER facts_applied',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

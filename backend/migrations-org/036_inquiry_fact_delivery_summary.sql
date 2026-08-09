-- Per-org migration: record the summary TaneChat sent, and which fields we declined.
--
-- The delivery ledger stored facts_json and fields_json but NOT `summary`, so the
-- parallel-run comparison could not check summaries at all — TaneChat's summary
-- only ever landed in inquiry.notes, and only when notes were empty, so a skipped
-- summary left no trace anywhere.
--
-- skipped_json records the fields provenance declined (already set by a human or by
-- our own extractor). Without it a replayed delivery cannot report the same
-- skipped_fields it reported the first time.

-- ── inquiry_fact_delivery.summary_text ──────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'summary_text');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN summary_text TEXT NULL DEFAULT NULL AFTER fields_json',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry_fact_delivery.summary_applied ───────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'summary_applied');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN summary_applied TINYINT(1) NOT NULL DEFAULT 0 AFTER summary_text',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry_fact_delivery.skipped_json ──────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'skipped_json');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN skipped_json JSON NULL DEFAULT NULL AFTER summary_applied',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

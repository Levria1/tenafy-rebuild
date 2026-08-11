-- Per-org migration: persist unit-text resolution outcomes for inquiry fact deliveries.
--
-- A replay MUST report exactly what the first attempt reported. Scalar columns cannot
-- do that: an `ambiguous` resolution's value to the caller IS the candidate list, and
-- rebuilding it from a stored unit id is impossible. So the whole response object is
-- stored verbatim and handed straight back, the same way `skipped_json` already works
-- in this table. One column, lossless, and no shape drift between first call and retry.

-- ── inquiry_fact_delivery.unit_text ─────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'unit_text');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN unit_text VARCHAR(255) NULL AFTER facts_skipped',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry_fact_delivery.unit_resolution_json ─────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'unit_resolution_json');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN unit_resolution_json JSON NULL AFTER unit_text',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

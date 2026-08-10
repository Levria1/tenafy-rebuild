-- Per-org migration: record short-stay dates and prices separately from monthly
-- inquiry budget.
--
-- `budget` is a monthly figure used against unit rent and in reports. OTA and
-- other short-stay channels quote nightly rates and discounted stay totals, so
-- keeping these money fields separate avoids corrupting monthly budget totals.

-- ── inquiry.desired_end_date ────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry'
     AND COLUMN_NAME = 'desired_end_date');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry ADD COLUMN desired_end_date DATE NULL DEFAULT NULL AFTER desired_start_date',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry.nightly_rate ────────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry'
     AND COLUMN_NAME = 'nightly_rate');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry ADD COLUMN nightly_rate DECIMAL(12,2) NULL DEFAULT NULL AFTER budget',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry.stay_total ──────────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry'
     AND COLUMN_NAME = 'stay_total');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry ADD COLUMN stay_total DECIMAL(12,2) NULL DEFAULT NULL AFTER nightly_rate',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

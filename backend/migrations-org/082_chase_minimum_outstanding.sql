-- Per-org migration: a floor below which an overdue invoice is not worth chasing.
--
-- The sweep chased any invoice with a cent outstanding. A tenant who paid
-- HK$17,600 of HK$18,000 rent got the same demand as one who paid nothing, and
-- the Overdue template threatens "5% of the monthly rent" per week — which reads
-- as absurd attached to a HK$400 rounding gap left by a bank transfer fee.
--
-- Two thresholds rather than one, because neither works alone:
--   min_outstanding_pct     proportional; handles the 17,600-of-18,000 case
--                           regardless of whether the rent is 8,000 or 80,000
--   min_outstanding_amount  a cash floor; 5% of a HK$305 utility bill is HK$15,
--                           which no one wants an automated demand about
-- An invoice is skipped when its outstanding falls below EITHER, so raising
-- either one can only ever chase fewer people.
--
-- Both default to 0, which means "no threshold" and preserves today's behaviour
-- exactly. Same stance as `enabled` in 077: a deploy must not change who gets
-- emailed. DECIMAL, not INT — a percentage wants 2.5 and money wants cents.
--
-- Idempotent: each ADD COLUMN is guarded by information_schema.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chase_setting'
               AND COLUMN_NAME = 'min_outstanding_pct');
SET @sql := IF(@col = 0,
  'ALTER TABLE chase_setting ADD COLUMN min_outstanding_pct DECIMAL(5,2) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chase_setting'
                AND COLUMN_NAME = 'min_outstanding_amount');
SET @sql2 := IF(@col2 = 0,
  'ALTER TABLE chase_setting ADD COLUMN min_outstanding_amount DECIMAL(12,2) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

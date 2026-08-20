-- 070_renewal_min_tenancy.sql  (PER-ORG)
-- A short lease can enter its notice window almost immediately after move-in. This
-- floor keeps the first renewal question from reaching a tenant before they have had
-- a reasonable chance to settle in. Zero remains available for operators who need no floor.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_min_tenancy_days');
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_min_tenancy_days SMALLINT NOT NULL DEFAULT 7', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

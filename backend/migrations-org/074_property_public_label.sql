-- 074_property_public_label.sql (PER-ORG)
-- Public building labels for website FAQ search/grouping.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='property' AND COLUMN_NAME='public_label');
SET @s := IF(@c=0, 'ALTER TABLE property ADD COLUMN public_label VARCHAR(120) NULL AFTER display_name', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='property' AND COLUMN_NAME='public_building_name');
SET @s := IF(@c=0, 'ALTER TABLE property ADD COLUMN public_building_name VARCHAR(120) NULL AFTER public_label', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='property' AND COLUMN_NAME='public_aliases');
SET @s := IF(@c=0, 'ALTER TABLE property ADD COLUMN public_aliases JSON NULL AFTER public_building_name', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 045_organization_public_slug.sql (MASTER). Nullable means website access fails closed.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='organizations' AND COLUMN_NAME='public_slug');
SET @s := IF(@c=0, 'ALTER TABLE organizations ADD COLUMN public_slug VARCHAR(63) CHARACTER SET ascii COLLATE ascii_general_ci NULL AFTER display_name', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='organizations' AND INDEX_NAME='uq_organizations_public_slug');
SET @s := IF(@i=0, 'ALTER TABLE organizations ADD UNIQUE KEY uq_organizations_public_slug (public_slug)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @k := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='organizations' AND CONSTRAINT_NAME='chk_organizations_public_slug');
SET @s := IF(@k=0, 'ALTER TABLE organizations ADD CONSTRAINT chk_organizations_public_slug CHECK (public_slug IS NULL OR public_slug REGEXP ''^[a-z0-9]([a-z0-9]|-[a-z0-9]){1,61}[a-z0-9]$'')', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Per-org migration: add a per-account super admin grant.
--
-- Super admin access was previously derivable only from organization.type = 6.
-- That is an org-wide property, so elevating one person meant elevating every
-- user in that org; in the live org 8300127259922432, that would grant all 10
-- active users permissions = ['*'] and bypass every role check. This column
-- makes the grant per-account. It defaults to 0, so applying the migration
-- changes nobody's access. organization.type = 6 continues to work unchanged
-- for orgs that legitimately have it.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user'
     AND COLUMN_NAME = 'is_super_admin');
SET @s := IF(@c = 0,
  'ALTER TABLE user ADD COLUMN is_super_admin TINYINT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

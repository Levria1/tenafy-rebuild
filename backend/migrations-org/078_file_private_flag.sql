-- Per-org migration: mark files that must never be served anonymously.
--
-- /api/file/preview and /api/file/download sit BEFORE the authenticate
-- middleware on purpose, so public listing photos load without a login. Their
-- anonymous rule is "images yes, documents no", which was safe while every
-- image in the table was a property photo.
--
-- Smart Extract now stores HKID and passport scans, which are images. Without a
-- flag they would fall on the public side of that rule, and a file id is a
-- timestamp-based Snowflake rather than a secret. This marks them private:
-- resolveAccessibleFile refuses them to anonymous callers whatever their type.
--
-- Idempotent: information_schema-guarded ALTER.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file'
               AND COLUMN_NAME = 'is_private');
SET @sql := IF(@col = 0,
  'ALTER TABLE file ADD COLUMN is_private TINYINT NOT NULL DEFAULT 0 COMMENT ''1 = never serve without a session, whatever the mime type''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Any ID screenshot already attached to a tenant is private by definition.
-- Harmless on a fresh install; matters on the org where this shipped first.
UPDATE file f
   JOIN object_file of2 ON of2.file_id = f.id AND of2.deleted_at IS NULL
   JOIN tenant t ON t.id = of2.object_id
   SET f.is_private = 1
 WHERE f.is_private = 0;

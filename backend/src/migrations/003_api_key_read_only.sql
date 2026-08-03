-- 003_api_key_read_only.sql  (MASTER db)
-- Adds a read-only scope to API keys. A key with read_only=1 may call GET/HEAD/
-- OPTIONS public endpoints only; any write (POST/PUT/PATCH/DELETE) is rejected 403
-- by the apiKeyAuth middleware. Lets us issue lookup-only keys (e.g. for a website
-- or a bot's read path) without write access.
--
-- Idempotent: information_schema-guarded (migrate.js tracks applied files anyway).

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys' AND COLUMN_NAME = 'read_only');
SET @ddl := IF(@c = 0,
  'ALTER TABLE api_keys ADD COLUMN read_only TINYINT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

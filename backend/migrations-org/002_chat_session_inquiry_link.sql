-- Per-org migration: link chat_session ↔ inquiry so the WhatsApp auto-extract
-- flow knows which sessions have already produced an inquiry, and lets the
-- daily re-extract job find "still active, no booking yet" sessions cheaply.
--
-- Idempotent — each column add is guarded.
--
-- Safety: some legacy orgs were provisioned BEFORE chat_session existed. If
-- the table is missing on this org, skip the whole migration (the WhatsApp
-- flow is opt-in per org and only orgs that have wired up TaneChat get a
-- chat_session table seeded). Whoever later turns on chat for that org will
-- get chat_session via the chat-feature provisioning step, and the columns
-- this migration adds are also in org_schema_template.sql so new orgs ship
-- with them already present.

-- Bail out early if chat_session doesn't exist on this org.
SET @table_exists = (SELECT COUNT(*) FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = DATABASE()
                       AND TABLE_NAME = 'chat_session');

-- inquiry_id: nullable FK back to inquiry table
SET @c = IF(@table_exists = 0, 1,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'chat_session'
                AND COLUMN_NAME = 'inquiry_id'));
SET @s = IF(@table_exists = 1 AND @c = 0,
  'ALTER TABLE chat_session ADD COLUMN inquiry_id BIGINT DEFAULT NULL, ADD INDEX idx_cs_inquiry (inquiry_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- last_extracted_at: timestamp of the most recent successful extract pass
SET @c = IF(@table_exists = 0, 1,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'chat_session'
                AND COLUMN_NAME = 'last_extracted_at'));
SET @s = IF(@table_exists = 1 AND @c = 0,
  'ALTER TABLE chat_session ADD COLUMN last_extracted_at TIMESTAMP NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- extract_count: number of extractions run on this session (initial + each daily diff)
SET @c = IF(@table_exists = 0, 1,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'chat_session'
                AND COLUMN_NAME = 'extract_count'));
SET @s = IF(@table_exists = 1 AND @c = 0,
  'ALTER TABLE chat_session ADD COLUMN extract_count INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

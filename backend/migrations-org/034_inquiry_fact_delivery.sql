-- Per-org migration: store idempotent TaneChat fact deliveries and provenance.

CREATE TABLE IF NOT EXISTS inquiry_fact_delivery (
  id               BIGINT       NOT NULL,
  org_id           BIGINT       NOT NULL,
  idempotency_key  VARCHAR(191) NOT NULL,
  payload_hash     CHAR(64)     NOT NULL,
  inquiry_id       BIGINT       DEFAULT NULL,
  applied          TINYINT      NOT NULL DEFAULT 0,
  reason           VARCHAR(64)  DEFAULT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ifd_org_key (org_id, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── inquiry.api_set_fields ──────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry'
     AND COLUMN_NAME = 'api_set_fields');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry ADD COLUMN api_set_fields JSON NULL DEFAULT NULL AFTER notes',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── chat_session.external_conversation_id ───────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_session'
     AND COLUMN_NAME = 'external_conversation_id');
SET @s := IF(@c = 0,
  'ALTER TABLE chat_session ADD COLUMN external_conversation_id VARCHAR(191) NULL DEFAULT NULL AFTER channel_user_id',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── chat_session.external_conversation_id index ─────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_session'
     AND INDEX_NAME = 'idx_cs_external_conv');
SET @s := IF(@c = 0,
  'ALTER TABLE chat_session ADD INDEX idx_cs_external_conv (external_conversation_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- NO BACKFILL. TaneChat will write provenance and external conversation ids
-- only for deliveries sent after cutover.

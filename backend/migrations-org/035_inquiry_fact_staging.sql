-- Per-org migration: stage Tenafy-side inquiry fact extraction during TaneChat parallel run.

CREATE TABLE IF NOT EXISTS inquiry_fact_staging (
  id           BIGINT      NOT NULL,
  org_id       BIGINT      NOT NULL,
  inquiry_id   BIGINT      NOT NULL,
  session_id   BIGINT      DEFAULT NULL,
  fact_line    TEXT        NOT NULL,
  occurred_on  DATE        DEFAULT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ifs_org_inquiry (org_id, inquiry_id),
  KEY idx_ifs_created (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── inquiry_fact_delivery.facts_json ────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'facts_json');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN facts_json JSON NULL DEFAULT NULL AFTER payload_hash',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── inquiry_fact_delivery.fields_json ───────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_fact_delivery'
     AND COLUMN_NAME = 'fields_json');
SET @s := IF(@c = 0,
  'ALTER TABLE inquiry_fact_delivery ADD COLUMN fields_json JSON NULL DEFAULT NULL AFTER facts_json',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

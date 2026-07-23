-- Per-org migration: advertising templates ("what to post" for a unit's listing).
-- A template holds ad copy (with placeholders) + webpage link and is reusable
-- across many units; each unit references at most one template. Forum/account/
-- schedule live elsewhere (the Scheduler), NOT here.
-- Idempotent: IF NOT EXISTS + information_schema guards so re-running is a no-op.

CREATE TABLE IF NOT EXISTS advertising_template (
  id            BIGINT       NOT NULL,
  org_id        BIGINT       NOT NULL,
  name          VARCHAR(160) NOT NULL,           -- internal label
  title         VARCHAR(255) DEFAULT NULL,        -- post headline (placeholders allowed)
  body          TEXT         DEFAULT NULL,        -- ad copy (placeholders allowed)
  webpage_link  VARCHAR(500) DEFAULT NULL,
  status        TINYINT      NOT NULL DEFAULT 1,  -- 1=active 0=archived
  deleted_at    TIMESTAMP    NULL DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adtpl_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- unit.advertising_template_id — the assignment (each unit → at most one template).
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'unit' AND COLUMN_NAME = 'advertising_template_id');
SET @s = IF(@c = 0,
  'ALTER TABLE unit ADD COLUMN advertising_template_id BIGINT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'unit' AND INDEX_NAME = 'idx_unit_ad_template');
SET @s = IF(@c = 0,
  'ALTER TABLE unit ADD INDEX idx_unit_ad_template (advertising_template_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

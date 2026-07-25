-- Per-org migration: per-unit line on templates + a post log for the posting plan.
-- Idempotent: information_schema guard for the column, IF NOT EXISTS for the table.

-- A bundled post = the shared template body posted ONCE + this line rendered per
-- unit (unit name / availability / rent differ). Placeholders resolve per unit.
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'advertising_template' AND COLUMN_NAME = 'per_unit_line');
SET @s = IF(@c = 0,
  'ALTER TABLE advertising_template ADD COLUMN per_unit_line VARCHAR(500) DEFAULT NULL AFTER body',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Records what was posted where — powers the forum rotation (avoid a property
-- reusing a forum within the week) and makes a plan re-run idempotent.
CREATE TABLE IF NOT EXISTS advertising_post_log (
  id           BIGINT    NOT NULL,
  org_id       BIGINT    NOT NULL,
  post_date    DATE      NOT NULL,
  property_id  BIGINT    DEFAULT NULL,
  template_id  BIGINT    DEFAULT NULL,
  forum_id     BIGINT    DEFAULT NULL,
  account_id   BIGINT    DEFAULT NULL,
  unit_ids     TEXT      DEFAULT NULL,   -- JSON array of the bundle's unit ids
  source       VARCHAR(16) NOT NULL DEFAULT 'roster',  -- 'roster' | 'urgent'
  status       VARCHAR(16) NOT NULL DEFAULT 'posted',  -- 'posted' | 'skipped'
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_postlog_org_date (org_id, post_date),
  KEY idx_postlog_property (org_id, property_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

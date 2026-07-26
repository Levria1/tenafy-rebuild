-- 020_advertising_unit_line.sql  (PER-ORG)
-- Named, reusable "unit line" presets for advertising templates. The per-unit
-- line (e.g. "%UnitName% (%Layout% unit - %Size%): Unit has a %BedSize% bed …")
-- is universal across templates, so it lives here ONCE as a library. A template
-- picks one via advertising_template.unit_line_id; NULL falls back to the org's
-- is_default preset, then to the template's own legacy per_unit_line column.
-- Same idea as the Shared Footer, but selectable.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + information_schema-guarded ALTER.

CREATE TABLE IF NOT EXISTS advertising_unit_line (
  id         BIGINT       NOT NULL,
  org_id     BIGINT       NOT NULL,
  name       VARCHAR(160) NOT NULL,
  line_text  VARCHAR(500) DEFAULT NULL,
  is_default TINYINT      NOT NULL DEFAULT 0,
  status     TINYINT      NOT NULL DEFAULT 1,
  deleted_at TIMESTAMP    NULL DEFAULT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adunitline_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- advertising_template.unit_line_id → which preset a template uses (NULL = default).
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'advertising_template' AND COLUMN_NAME = 'unit_line_id');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_template ADD COLUMN unit_line_id BIGINT DEFAULT NULL AFTER per_unit_line',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

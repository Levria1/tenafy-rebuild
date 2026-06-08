-- Per-org migration: lease template system + new lease state machinery.
-- Idempotent — each column/table guarded by information_schema check or
-- CREATE TABLE IF NOT EXISTS.
--
-- Adds:
--   - lease_template, lease_template_revision  (new tables)
--   - leasing.template_id                       (which template generated the PDF)
--   - leasing.template_version_used             (which revision — for audit)
--   - leasing.lease_state                       ('pending' | 'active', default 'active')
--   - leasing.signature_status                  ('none' | 'pending' | 'signed' | 'declined')
--   - leasing.signed_file_id                    (file table pointer to final signed PDF)
--   - leasing.signed_at                         (when final party signed)
--   - booking_platform.requires_signature       (auto-tick the e-sign checkbox on lease wizard)

-- ── lease_template ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_template (
  id            BIGINT      NOT NULL,
  org_id        BIGINT      NOT NULL,
  name          VARCHAR(255) NOT NULL,
  description   TEXT        DEFAULT NULL,
  body_html     LONGTEXT    DEFAULT NULL,        -- main body (Quill output)
  header_html   TEXT        DEFAULT NULL,        -- repeats on every page top
  footer_html   TEXT        DEFAULT NULL,        -- repeats on every page bottom
  page_size     VARCHAR(10) NOT NULL DEFAULT 'A4',
  is_default    TINYINT     NOT NULL DEFAULT 0,  -- 1 = org's default template
  status        TINYINT     NOT NULL DEFAULT 1,  -- 1=active, 0=archived
  version       INT         NOT NULL DEFAULT 1,  -- bumped on each save
  created_by    BIGINT      DEFAULT NULL,
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_lt_org_status (org_id, status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── lease_template_revision ──────────────────────────────────────────────────
-- Snapshot every save so a signed lease's PDF can always be re-rendered exactly
-- as it was at signing time, even if the template was edited later.
CREATE TABLE IF NOT EXISTS lease_template_revision (
  id           BIGINT     NOT NULL,
  template_id  BIGINT     NOT NULL,
  version      INT        NOT NULL,
  body_html    LONGTEXT   DEFAULT NULL,
  header_html  TEXT       DEFAULT NULL,
  footer_html  TEXT       DEFAULT NULL,
  edited_by    BIGINT     DEFAULT NULL,
  edited_at    TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ltr_template (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── leasing.template_id ──────────────────────────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'template_id');
SET @s = IF(@c = 0,
  'ALTER TABLE leasing ADD COLUMN template_id BIGINT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── leasing.template_version_used ────────────────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'template_version_used');
SET @s = IF(@c = 0,
  'ALTER TABLE leasing ADD COLUMN template_version_used INT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── leasing.lease_state ──────────────────────────────────────────────────────
-- 'pending' = drafted, doesn't fire invoices, but still reserves the unit.
-- 'active'  = normal lease behavior (default for back-compat).
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'lease_state');
SET @s = IF(@c = 0,
  "ALTER TABLE leasing ADD COLUMN lease_state ENUM('pending','active') NOT NULL DEFAULT 'active'",
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Index so the scheduler's "active leases" filter stays fast.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND INDEX_NAME = 'idx_lease_state');
SET @s = IF(@c = 0,
  'ALTER TABLE leasing ADD INDEX idx_lease_state (lease_state)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── leasing.signature_status ─────────────────────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'signature_status');
SET @s = IF(@c = 0,
  "ALTER TABLE leasing ADD COLUMN signature_status ENUM('none','pending','signed','declined') NOT NULL DEFAULT 'none'",
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── leasing.signed_file_id ───────────────────────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'signed_file_id');
SET @s = IF(@c = 0,
  'ALTER TABLE leasing ADD COLUMN signed_file_id BIGINT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── leasing.signed_at ────────────────────────────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'signed_at');
SET @s = IF(@c = 0,
  'ALTER TABLE leasing ADD COLUMN signed_at TIMESTAMP NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── booking_platform.requires_signature ──────────────────────────────────────
-- Drives the "Send for e-signature" auto-tick on the lease wizard. Default 1
-- (=most platforms require a signed contract). Staff flip to 0 for Airbnb,
-- Booking.com, etc. — short-term stays where no contract is signed.
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'booking_platform' AND COLUMN_NAME = 'requires_signature');
SET @s = IF(@c = 0,
  'ALTER TABLE booking_platform ADD COLUMN requires_signature TINYINT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

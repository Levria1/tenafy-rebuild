-- Per-org catch-up: brings any org DB that drifted behind the current code up to
-- date with the recent per-org schema additions. FULLY IDEMPOTENT — safe to run
-- on an already-current org (Tane Residence), a freshly-patched one (Alex Kot),
-- and any future org. Uses CREATE TABLE IF NOT EXISTS and information_schema-
-- guarded ALTERs (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
--
-- Going forward: each NEW per-org schema change gets its own NNN_*.sql file in
-- this folder. This 000 file is the one-time backlog catch-up.

-- ── property.leasing_cost (migration 028) ─────────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'property' AND COLUMN_NAME = 'leasing_cost');
SET @s = IF(@c = 0,
  'ALTER TABLE property ADD COLUMN leasing_cost DECIMAL(12,2) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── lease_revision (migration 036) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_revision (
  id bigint NOT NULL,
  lease_id bigint NOT NULL,
  effective_from date NOT NULL,
  price decimal(10,2) DEFAULT NULL,
  credits varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  utility_credit decimal(10,2) DEFAULT NULL,
  deposit decimal(10,2) DEFAULT NULL,
  note text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  created_by bigint DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at timestamp NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_lease_effective (lease_id, effective_from),
  KEY idx_effective_from (effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── inquiry (+ viewing_booking.inquiry_id) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS inquiry (
  id BIGINT PRIMARY KEY,
  org_id BIGINT NOT NULL,
  inquiry_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lead_source_id BIGINT DEFAULT NULL,
  first_name VARCHAR(255) DEFAULT NULL,
  last_name VARCHAR(255) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  phone VARCHAR(50) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  unit_id BIGINT DEFAULT NULL,
  property_id BIGINT DEFAULT NULL,
  created_by_user_id BIGINT DEFAULT NULL,
  tenant_id BIGINT DEFAULT NULL,
  desired_start_date DATE DEFAULT NULL,
  budget DECIMAL(12,2) DEFAULT NULL,
  reminder_date DATE DEFAULT NULL,
  reminder_sent_at DATETIME DEFAULT NULL,
  status TINYINT NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  INDEX idx_org_status (org_id, status, deleted_at),
  INDEX idx_org_email (org_id, email),
  INDEX idx_tenant (tenant_id),
  INDEX idx_reminder (reminder_date, reminder_sent_at, deleted_at)
);

SET @vb = (SELECT COUNT(*) FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_booking');
SET @vc = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_booking' AND COLUMN_NAME = 'inquiry_id');
SET @s = IF(@vb = 1 AND @vc = 0,
  'ALTER TABLE viewing_booking ADD COLUMN inquiry_id BIGINT DEFAULT NULL, ADD INDEX idx_inquiry (inquiry_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── chat_knowledge (migration 041 — shared chatbot rulebook) ──────────────────
CREATE TABLE IF NOT EXISTS chat_knowledge (
  id bigint NOT NULL,
  kind varchar(16) NOT NULL DEFAULT 'rule',
  title varchar(255) DEFAULT NULL,
  body text NOT NULL,
  tags json DEFAULT NULL,
  visibility varchar(16) NOT NULL DEFAULT 'internal',
  status tinyint NOT NULL DEFAULT 1,
  sort_order int NOT NULL DEFAULT 0,
  source varchar(32) NOT NULL DEFAULT 'manual',
  source_ref bigint DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status_visibility (status, visibility)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

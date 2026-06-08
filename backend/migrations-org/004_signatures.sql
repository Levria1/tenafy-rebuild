-- Per-org migration: e-signature tables + landlord signature management.
-- All idempotent.
--
-- Tables added:
--   signature_request    — one row per signing process
--   signature_party      — one row per signer (1-2 typical, can be more)
--   signature_event      — append-only audit log
--   landlord_signature   — uploaded landlord signature images (PNG)
--
-- Columns added:
--   property.default_landlord_signature_id  — per-property default

-- ── signature_request ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signature_request (
  id                 BIGINT NOT NULL,
  org_id             BIGINT NOT NULL,
  lease_id           BIGINT DEFAULT NULL,
  template_id        BIGINT DEFAULT NULL,
  template_version   INT    DEFAULT NULL,
  original_file_id   BIGINT DEFAULT NULL,         -- unsigned PDF (file table)
  signed_file_id     BIGINT DEFAULT NULL,         -- final stamped PDF (file table)
  landlord_signature_id BIGINT DEFAULT NULL,      -- which landlord sig was used
  token              VARCHAR(64) NOT NULL,        -- public URL token (no /sign/ prefix)
  status             TINYINT NOT NULL DEFAULT 0,  -- 0=draft 1=sent 2=viewed 3=fully_signed 4=declined 5=expired 6=cancelled
  message            TEXT DEFAULT NULL,           -- optional message from sender to signers
  expires_at         TIMESTAMP NULL DEFAULT NULL,
  sent_at            TIMESTAMP NULL DEFAULT NULL,
  completed_at       TIMESTAMP NULL DEFAULT NULL,
  created_by         BIGINT DEFAULT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sr_token (token),
  KEY idx_sr_lease (lease_id),
  KEY idx_sr_org_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── signature_party ───────────────────────────────────────────────────────────
-- One row per individual signer attached to a request. Sub-token lets each
-- party sign with their own unique URL so we know exactly who signed when.
CREATE TABLE IF NOT EXISTS signature_party (
  id              BIGINT NOT NULL,
  request_id      BIGINT NOT NULL,
  party_token     VARCHAR(64) NOT NULL,            -- per-signer URL token
  signer_name     VARCHAR(255) NOT NULL,
  signer_email    VARCHAR(255) DEFAULT NULL,
  role            VARCHAR(32)  NOT NULL DEFAULT 'tenant',  -- tenant|guarantor|other
  sort_order      INT NOT NULL DEFAULT 0,
  status          TINYINT NOT NULL DEFAULT 0,      -- 0=pending 1=viewed 2=signed 3=declined
  signature_png   LONGTEXT DEFAULT NULL,           -- base64 PNG of drawn signature
  typed_name      VARCHAR(255) DEFAULT NULL,       -- typed full name (legal)
  viewed_at       TIMESTAMP NULL DEFAULT NULL,
  signed_at       TIMESTAMP NULL DEFAULT NULL,
  declined_at     TIMESTAMP NULL DEFAULT NULL,
  decline_reason  TEXT DEFAULT NULL,
  signer_ip       VARCHAR(64) DEFAULT NULL,
  signer_ua       VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sp_token (party_token),
  KEY idx_sp_request (request_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── signature_event ──────────────────────────────────────────────────────────
-- Append-only log. One row per state-changing event. Drives the audit trail
-- on the Certificate of Completion page.
CREATE TABLE IF NOT EXISTS signature_event (
  id          BIGINT NOT NULL,
  request_id  BIGINT NOT NULL,
  party_id    BIGINT DEFAULT NULL,
  event_type  VARCHAR(32) NOT NULL,   -- sent|viewed|signed|declined|cancelled|expired|completed|resent
  ip          VARCHAR(64) DEFAULT NULL,
  user_agent  VARCHAR(500) DEFAULT NULL,
  metadata    JSON DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_se_request (request_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── landlord_signature ───────────────────────────────────────────────────────
-- Uploaded PNG signatures (the landlord's actual ink-on-paper signature,
-- scanned/snapped and saved). Multiple per org (one per landlord entity).
-- Linked to a property as that property's default via property.default_landlord_signature_id.
CREATE TABLE IF NOT EXISTS landlord_signature (
  id             BIGINT NOT NULL,
  org_id         BIGINT NOT NULL,
  label          VARCHAR(255) NOT NULL,    -- "HK Corp Ltd", "Alex Wong", etc.
  signature_png  LONGTEXT NOT NULL,        -- base64 PNG (data URL stripped)
  is_default     TINYINT NOT NULL DEFAULT 0,
  status         TINYINT NOT NULL DEFAULT 1,
  created_by     BIGINT DEFAULT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_ls_org (org_id, status, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── property.default_landlord_signature_id ───────────────────────────────────
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'property' AND COLUMN_NAME = 'default_landlord_signature_id');
SET @s = IF(@c = 0,
  'ALTER TABLE property ADD COLUMN default_landlord_signature_id BIGINT DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

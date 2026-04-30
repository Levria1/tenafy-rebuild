-- =============================================================================
-- WhatsApp integration migration
-- Run on each ORG database (per multi-tenant setup).
-- =============================================================================

-- 1. Separate WhatsApp template table (Option A — independent of email_template)
CREATE TABLE IF NOT EXISTS whatsapp_template (
  id BIGINT NOT NULL PRIMARY KEY,
  org_id BIGINT NOT NULL,
  template_name VARCHAR(255) NOT NULL,
  template_type VARCHAR(64) NOT NULL,
  template_content TEXT NOT NULL,
  is_default_template TINYINT(1) NOT NULL DEFAULT 2,    -- 1=default, 2=non-default
  status TINYINT(1) NOT NULL DEFAULT 1,                  -- 1=active, 0=deleted
  before_date TINYINT(1) NOT NULL DEFAULT 1,             -- 1=before event, 0=after
  date_first INT DEFAULT NULL,                           -- offset days for first send
  date_second INT DEFAULT NULL,                          -- offset days for second send
  created_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_time DATETIME NULL,
  KEY idx_org_type (org_id, template_type),
  KEY idx_org_default (org_id, template_type, is_default_template)
);

-- 2. Per-tenant opt-out
ALTER TABLE tenant
  ADD COLUMN whatsapp_opt_out TINYINT(1) NOT NULL DEFAULT 0;

-- 3. Org-level WhatsApp whitelist + per-org integration credentials
--    (each org runs their OWN TaneChat instance — Model B / per-org self-hosted)
ALTER TABLE organization
  ADD COLUMN whatsapp_api_url VARCHAR(255) NULL,
  ADD COLUMN whatsapp_api_key VARCHAR(255) NULL,
  ADD COLUMN whatsapp_whitelist_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN whatsapp_whitelist TEXT NULL;

-- 4. WhatsApp send log (mirror of email_log)
CREATE TABLE IF NOT EXISTS whatsapp_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT NOT NULL,
  to_phone VARCHAR(32) NOT NULL,
  message TEXT NULL,
  type VARCHAR(64) NULL,           -- template type, e.g. 'Overdue-Tenant'
  template_id BIGINT NULL,
  lease_id BIGINT NULL,
  status VARCHAR(32) NOT NULL,     -- sent | failed | whitelist_blocked | skipped_no_phone | skipped_opt_out | skipped_no_template
  error TEXT NULL,
  wa_message_id VARCHAR(128) NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_org_lease (org_id, lease_id),
  KEY idx_org_type (org_id, type),
  KEY idx_created (created_at)
);

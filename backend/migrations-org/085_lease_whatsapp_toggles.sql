-- Per-lease WhatsApp notification switches, separate from the email ones.
--
-- Until now a tenant WhatsApp went out only as a side effect of the email:
-- sendTemplateEmail dispatched it after the email had passed its own lease toggle,
-- recipient and whitelist checks. Unticking "Email tenant when invoice is overdue"
-- therefore silenced the WhatsApp too, and a tenant with a phone but no email got
-- nothing. Each channel now has its own tickbox on Create/Edit Lease.
--
-- tinyint(1), not bit(1): bit columns reach JavaScript as Buffers (see
-- utils/mysqlBit.js), and there is no reason to add more of them.
--
-- Existing leases start with WhatsApp matching their current email ticks (owner's
-- choice, 2026-11-04), so nothing changes for anyone until a box is changed. The
-- backfill runs only in the same pass that adds the columns, so re-running this file
-- can never overwrite choices made since. Nothing is sent unless the matching
-- WhatsApp template is also Active.
-- Idempotent: guarded by information_schema.

SET @added := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing'
                 AND COLUMN_NAME = 'wa_tenant_posted');

SET @sql := IF(@added,
  'ALTER TABLE leasing
     ADD COLUMN wa_tenant_posted TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN wa_tenant_overdue TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN wa_tenant_deposit_posted TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN wa_tenant_checkin TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN wa_tenant_checkout TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN wa_tenant_renewal TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@added,
  'UPDATE leasing SET
     wa_tenant_posted = COALESCE(tenant_posted = 1, 0),
     wa_tenant_overdue = COALESCE(tenant_overdue = 1, 0),
     wa_tenant_deposit_posted = COALESCE(tenant_deposit_posted = 1, 0),
     wa_tenant_checkin = COALESCE(tenant_checkin = 1, 0),
     wa_tenant_checkout = COALESCE(tenant_checkout = 1, 0),
     wa_tenant_renewal = COALESCE(tenant_renewal = 1, 0)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

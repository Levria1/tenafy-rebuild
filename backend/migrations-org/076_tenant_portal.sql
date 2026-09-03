-- 076_tenant_portal.sql (PER-ORG)
-- Tenant portal accounts, and the one field staff can write that a tenant reads.
--
-- WHY A SEPARATE TABLE AND NOT `user`
--
-- The portal already existed and logged tenants in by finding a row in `user` whose
-- email matched a `tenant`. That is the root of a real hole: `user` is the STAFF table,
-- the token it produced went into the same `__s_t` cookie signed with the same secret,
-- and middleware/auth.js never looked at `role`. 412 staff endpoints sit behind bare
-- `authenticate`, so a tenant login was in effect a staff login. It was never exploited
-- only because no tenant has ever had a `user` row (10 exist, all staff).
--
-- Opening the portal to ~1,721 tenants is exactly what would have exposed it, so
-- credentials move out of `user` entirely. A tenant is not a diminished employee.
--
-- WHY THERE IS NO tenant_id COLUMN
--
-- The account is credentials only; which tenant rows it can see is resolved by email on
-- each request. 13 email addresses in production map to more than one `tenant` row
-- (Eiji Tsuchizawa has 4, Danilo Wanner 3) because a person re-leasing gets a new row.
-- Storing one tenant_id would arbitrarily hide the rest of that person's history.
--
-- This assumes a shared email means one person. Verified true for all 13 as of
-- 2026-09-03: every case is the same person or company under spelling variants, plus
-- two test records. If a genuinely shared address ever appears (two unrelated tenants
-- on one company mailbox) this resolution must become explicit linkage instead.

CREATE TABLE IF NOT EXISTS tenant_portal_account (
  id                BIGINT       NOT NULL PRIMARY KEY,
  org_id            BIGINT       NOT NULL,
  email             VARCHAR(255) NOT NULL,
  -- NULL until the emailed link is used. A row can exist unverified, which is what
  -- lets a repeat "register" refresh the token instead of creating duplicates.
  password_hash     VARCHAR(255) NULL,
  -- 0 = unverified, 1 = active, 2 = disabled (staff kill switch)
  status            TINYINT      NOT NULL DEFAULT 0,
  -- sha256 of the token that was emailed. The plaintext is never stored, so a dump of
  -- this table does not let anyone complete a pending registration.
  verify_token_hash CHAR(64)     NULL,
  verify_expires_at DATETIME     NULL,
  last_login_at     DATETIME     NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenant_portal_account_org_email (org_id, email),
  KEY idx_tenant_portal_account_verify (verify_token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The note staff write FOR the tenant.
--
-- Deliberately a second column rather than a "visible to tenant" flag on `note`.
-- `note` is internal (its own placeholder in the staff UI reads "Internal notes...").
-- A box that is private UNLESS someone ticks something is a rule nobody holds reliably
-- at the end of a long day, and the failure mode is an internal remark about a tenant
-- being shown to that tenant. Always-visible is a rule that survives a busy Friday.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='service' AND COLUMN_NAME='tenant_note');
SET @s := IF(@c=0, 'ALTER TABLE service ADD COLUMN tenant_note LONGTEXT NULL AFTER note', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Which attachments a tenant is allowed to see back.
--
-- `object_file` is a shared junction, so a service request accumulates BOTH the tenant's
-- own photos and whatever staff attach later: vendor quotations, inspection shots, files
-- whose names identify the assignee. Returning every linked file to the tenant would
-- quietly undo the rule that they never see vendor or internal information.
--
-- Marking the tenant's own uploads at insert time is the only reliable discriminator;
-- timestamps are not, because staff often attach something moments after a submission.
-- NULL keeps every existing row and every staff upload out of the tenant's view by
-- default, which is the safe direction for a column added to a live table.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='object_file' AND COLUMN_NAME='source');
SET @s := IF(@c=0, 'ALTER TABLE object_file ADD COLUMN source VARCHAR(16) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Session generation. Bumped whenever the password changes.
--
-- A signed token proves who logged in, not that the login is still meant to work. Without
-- this, resetting a password because someone else has your cookie leaves that cookie
-- valid until it expires, which is precisely the moment it must stop working. The token
-- carries the version it was issued under and the middleware compares on every request.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_portal_account' AND COLUMN_NAME='token_version');
SET @s := IF(@c=0, 'ALTER TABLE tenant_portal_account ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER status', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

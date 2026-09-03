-- 002_tenant_portal_map.sql (MASTER)
--
-- Which org owns a tenant portal login. Mirrors `org_user_map`, which does the same job
-- for staff, deliberately: login has to find the org BEFORE it can open an org pool, so
-- the lookup cannot live in a per-org database.
--
-- Written when a registration COMPLETES, not when it starts, so a row here means "this
-- email has a usable portal account" rather than "someone once typed this address".
--
-- Email is the primary key, so one address maps to exactly one org, same as `org_user_map`
-- keys on username. Three orgs exist today and a tenant belongs to one of them. If a real
-- person ever needs a portal login in two orgs at once, this is the constraint that has to
-- be revisited, and it will fail loudly at registration rather than silently.

CREATE TABLE IF NOT EXISTS tenant_portal_map (
  email    VARCHAR(255) NOT NULL PRIMARY KEY,
  org_id   BIGINT       NOT NULL,
  db_name  VARCHAR(128) NOT NULL,
  created_at TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant_portal_map_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

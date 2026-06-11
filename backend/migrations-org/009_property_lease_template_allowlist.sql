-- 009_property_lease_template_allowlist.sql  (PER-ORG)
-- Per-property allowlist of lease templates (see main migration 043 for the
-- full rationale). When a property has rows here, the e-signature template
-- dropdown is restricted to exactly those templates; a property with no rows
-- is unrestricted.
--
-- CREATE TABLE IF NOT EXISTS is idempotent on its own.

CREATE TABLE IF NOT EXISTS property_lease_template (
  org_id      BIGINT    NOT NULL,
  property_id BIGINT    NOT NULL,
  template_id BIGINT    NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (property_id, template_id),
  KEY idx_plt_template (template_id),
  KEY idx_plt_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

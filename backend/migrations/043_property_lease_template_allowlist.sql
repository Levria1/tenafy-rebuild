-- 043_property_lease_template_allowlist.sql  (MAIN DB)
-- Per-property allowlist of lease templates. When a property has one or more
-- rows here, the e-signature template dropdown is RESTRICTED to exactly those
-- templates — staff cannot pick any other. A property with NO rows is
-- unrestricted (every template is selectable), so existing properties keep
-- working until you configure them.
--
-- Many-to-many: a property may allow several templates; a template may be
-- allowed on several properties.
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

-- 044_property_email_template.sql
-- Links email templates to properties (building allowlist), mirroring
-- property_lease_template. Only the Payment-Options template type uses it.
CREATE TABLE IF NOT EXISTS `property_email_template` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `property_id` bigint NOT NULL,
  `template_id` bigint NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pet_org_template` (`org_id`, `template_id`),
  KEY `idx_pet_org_property` (`org_id`, `property_id`)
);

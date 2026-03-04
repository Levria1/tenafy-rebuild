-- Migration 003: Create property_owner_tag and property_owner_tag_map tables
-- property_owner_tag: tag taxonomy scoped per org
-- property_owner_tag_map: many-to-many between property owners and tags

CREATE TABLE IF NOT EXISTS `property_owner_tag` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `org_id`     BIGINT       NOT NULL,
  `name`       VARCHAR(100) NOT NULL,
  `color`      VARCHAR(20)  NOT NULL DEFAULT '#1890ff',
  `status`     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1=active, 0=deleted',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pot_org` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `property_owner_tag_map` (
  `property_owner_id` BIGINT NOT NULL,
  `tag_id`            BIGINT NOT NULL,
  PRIMARY KEY (`property_owner_id`, `tag_id`),
  KEY `idx_potm_tag` (`tag_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

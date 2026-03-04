-- Migration 002: Create unit_inventory_history table
-- Tracks all changes (add/remove/update/adjust) made to unit inventory items

CREATE TABLE IF NOT EXISTS `unit_inventory_history` (
  `id`              BIGINT       NOT NULL AUTO_INCREMENT,
  `unit_id`         BIGINT       NOT NULL,
  `org_id`          BIGINT       NOT NULL,
  `inventory_id`    BIGINT       NOT NULL COMMENT 'FK to unit_inventory.id',
  `action`          VARCHAR(20)  NOT NULL COMMENT 'ADD | REMOVE | UPDATE | ADJUST',
  `quantity_before` INT          DEFAULT NULL,
  `quantity_after`  INT          DEFAULT NULL,
  `note`            TEXT         DEFAULT NULL,
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_uih_unit`      (`unit_id`),
  KEY `idx_uih_org`       (`org_id`),
  KEY `idx_uih_inventory` (`inventory_id`),
  KEY `idx_uih_action`    (`action`),
  KEY `idx_uih_created`   (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

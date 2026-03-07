-- Migration 005: Create unit_inventory table
-- Current inventory items per unit (furnishings, appliances, etc.)

CREATE TABLE IF NOT EXISTS `unit_inventory` (
  `id`               BIGINT        NOT NULL AUTO_INCREMENT,
  `org_id`           BIGINT        NOT NULL,
  `unit_id`          BIGINT        NOT NULL,
  `name`             VARCHAR(255)  NOT NULL,
  `description`      LONGTEXT      DEFAULT NULL,
  `quantity`         INT           NOT NULL DEFAULT 1,
  `condition_status` VARCHAR(50)   DEFAULT NULL COMMENT 'NEW, GOOD, FAIR, POOR, DAMAGED',
  `value`            DECIMAL(10,2) DEFAULT NULL,
  `purchase_date`    DATE          DEFAULT NULL,
  `active_status`    TINYINT       NOT NULL DEFAULT 1 COMMENT '0=deleted, 1=active',
  `created_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_unit_inventory_unit` (`unit_id`),
  KEY `idx_unit_inventory_org`  (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

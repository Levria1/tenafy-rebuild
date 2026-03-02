-- ============================================================
-- Tenafy Rebuild - New Tables Migration
-- Run against: tena_prod
-- These tables do NOT exist in the original schema and need
-- to be created before the new features will work.
-- ============================================================

USE tena_prod;

-- ------------------------------------------------------------
-- unit_maintenance
-- Tracks maintenance/repair costs per unit
-- (separate from the 'service' request table)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `unit_maintenance` (
  `id`               bigint(20)    NOT NULL AUTO_INCREMENT,
  `org_id`           bigint(20)    NOT NULL,
  `unit_id`          bigint(20)    NOT NULL,
  `title`            varchar(255)  NOT NULL,
  `description`      longtext      DEFAULT NULL,
  `cost`             decimal(10,2) NOT NULL DEFAULT '0.00',
  `category`         varchar(50)   NOT NULL DEFAULT 'GENERAL'
                     COMMENT 'GENERAL,PLUMBING,ELECTRICAL,HVAC,APPLIANCE,STRUCTURAL,PAINTING,CLEANING,LANDSCAPING,OTHER',
  `vendor_name`      varchar(200)  DEFAULT NULL,
  `maintenance_date` date          DEFAULT NULL,
  `status`           tinyint(4)    NOT NULL DEFAULT '1' COMMENT '0:deleted; 1:active',
  `created_at`       timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_unit_id` (`unit_id`),
  KEY `idx_org_id` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Unit maintenance cost tracking';

-- ------------------------------------------------------------
-- unit_inventory
-- Current inventory items per unit (furnishings, appliances)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `unit_inventory` (
  `id`               bigint(20)    NOT NULL AUTO_INCREMENT,
  `unit_id`          bigint(20)    NOT NULL,
  `name`             varchar(255)  NOT NULL,
  `internal_note`    longtext      DEFAULT NULL,
  `quantity`         int(11)       NOT NULL DEFAULT '1',
  `condition_status` varchar(50)   DEFAULT NULL
                     COMMENT 'NEW,GOOD,FAIR,POOR,DAMAGED',
  `value`            decimal(10,2) DEFAULT NULL,
  `purchase_date`    date          DEFAULT NULL,
  `active_status`    tinyint(4)    NOT NULL DEFAULT '1' COMMENT '0:deleted; 1:active',
  `created_at`       timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_unit_id` (`unit_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Unit inventory items (furnishings, appliances, etc.)';

-- ------------------------------------------------------------
-- unit_inventory_history
-- Audit log of all inventory changes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `unit_inventory_history` (
  `id`           bigint(20)    NOT NULL AUTO_INCREMENT,
  `unit_id`      bigint(20)    NOT NULL,
  `item_id`      bigint(20)    DEFAULT NULL COMMENT 'FK to unit_inventory.id',
  `item_name`    varchar(255)  NOT NULL,
  `action`       varchar(20)   NOT NULL COMMENT 'ADD,REMOVE,UPDATE,ADJUST',
  `quantity`     int(11)       DEFAULT NULL,
  `value`        decimal(10,2) DEFAULT NULL,
  `note`         longtext      DEFAULT NULL,
  `created_by`   bigint(20)    DEFAULT NULL,
  `created_at`   timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_unit_id` (`unit_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Audit history of inventory changes per unit';

-- ------------------------------------------------------------
-- email_log
-- Tracks emails sent (for admin monitoring dashboard)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `email_log` (
  `id`         bigint(20)    NOT NULL AUTO_INCREMENT,
  `org_id`     bigint(20)    DEFAULT NULL,
  `to_email`   varchar(255)  NOT NULL,
  `subject`    varchar(500)  DEFAULT NULL,
  `type`       varchar(100)  DEFAULT NULL
               COMMENT 'e.g. invoice, lease_expiry, overdue_reminder, invitation',
  `status`     varchar(20)   NOT NULL DEFAULT 'sent'
               COMMENT 'sent,failed',
  `error`      longtext      DEFAULT NULL,
  `created_at` timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Log of all outbound emails for monitoring';

-- ------------------------------------------------------------
-- user_verification_token already exists in tena_prod (line 2952)
-- property_owner_tag already exists in tena_prod (line 2516)
-- No action needed for those.
-- ------------------------------------------------------------

SELECT 'Migration complete. Tables created: unit_maintenance, unit_inventory, unit_inventory_history, email_log' as status;

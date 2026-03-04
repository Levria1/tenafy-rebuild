-- Migration 001: Create unit_maintenance table
-- Tracks maintenance records for units (repairs, inspections, etc.)

CREATE TABLE IF NOT EXISTS `unit_maintenance` (
  `id`               BIGINT         NOT NULL AUTO_INCREMENT,
  `org_id`           BIGINT         NOT NULL,
  `unit_id`          BIGINT         NOT NULL,
  `title`            VARCHAR(255)   NOT NULL,
  `description`      TEXT           DEFAULT NULL,
  `cost`             DECIMAL(15,2)  NOT NULL DEFAULT 0.00,
  `category`         VARCHAR(100)   NOT NULL DEFAULT 'GENERAL',
  `vendor_name`      VARCHAR(255)   DEFAULT NULL,
  `maintenance_date` DATE           DEFAULT NULL,
  `status`           TINYINT(1)     NOT NULL DEFAULT 1 COMMENT '1=active, 0=deleted',
  `created_at`       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME       DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_unit_maintenance_unit`   (`unit_id`),
  KEY `idx_unit_maintenance_org`    (`org_id`),
  KEY `idx_unit_maintenance_date`   (`maintenance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

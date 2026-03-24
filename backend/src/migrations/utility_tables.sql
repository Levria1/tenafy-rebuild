-- Utility billing module tables
-- Run against each org database (e.g. tena_prod)

-- Groups of meters that are billed together on one utility bill
CREATE TABLE IF NOT EXISTS `utility_group` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `property_id` bigint DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT 1 COMMENT '1=active, 0=deleted',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_property_id` (`property_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Individual meters assigned to units (or common area if unit_id is NULL)
CREATE TABLE IF NOT EXISTS `utility_meter` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  `unit_id` bigint DEFAULT NULL COMMENT 'NULL = common area meter',
  `meter_number` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `meter_type` tinyint NOT NULL DEFAULT 0 COMMENT '0=electric, 1=water, 2=gas',
  `current_reading` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status` tinyint NOT NULL DEFAULT 1 COMMENT '1=active, 0=deleted',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_group_id` (`group_id`),
  KEY `idx_unit_id` (`unit_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The combined utility bill from the electric company
CREATE TABLE IF NOT EXISTS `utility_bill` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `total_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `total_kw` decimal(12,2) NOT NULL DEFAULT 0.00,
  `rate_per_kw` decimal(10,4) NOT NULL DEFAULT 0.0000,
  `status` tinyint NOT NULL DEFAULT 0 COMMENT '0=draft, 1=finalized',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_group_id` (`group_id`),
  KEY `idx_period` (`period_start`, `period_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-meter/tenant breakdown within a bill
CREATE TABLE IF NOT EXISTS `utility_bill_line` (
  `id` bigint NOT NULL,
  `bill_id` bigint NOT NULL,
  `meter_id` bigint NOT NULL,
  `unit_id` bigint DEFAULT NULL,
  `tenant_id` bigint DEFAULT NULL,
  `leasing_id` bigint DEFAULT NULL,
  `starting_reading` decimal(12,2) NOT NULL DEFAULT 0.00,
  `ending_reading` decimal(12,2) NOT NULL DEFAULT 0.00,
  `kw_used` decimal(12,2) NOT NULL DEFAULT 0.00,
  `gross_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `utility_credit` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT 'Monthly credit from lease',
  `lease_start` date DEFAULT NULL,
  `lease_end` date DEFAULT NULL,
  `prorated_days` int DEFAULT NULL,
  `total_period_days` int DEFAULT NULL,
  `prorated_credit` decimal(10,2) NOT NULL DEFAULT 0.00,
  `net_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `is_common_area` tinyint NOT NULL DEFAULT 0,
  `invoice_id` bigint DEFAULT NULL COMMENT 'NULL until invoice generated',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bill_id` (`bill_id`),
  KEY `idx_meter_id` (`meter_id`),
  KEY `idx_tenant_id` (`tenant_id`),
  KEY `idx_invoice_id` (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Junction table: which units belong to which billing group
CREATE TABLE IF NOT EXISTS `utility_unit_group` (
  `unit_id` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  PRIMARY KEY (`unit_id`, `group_id`),
  KEY `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add utility_credit column to leasing table
ALTER TABLE `leasing` ADD COLUMN `utility_credit` decimal(10,2) DEFAULT NULL AFTER `credits`;

-- Cleaning module tables
-- Run against each org database (e.g. tena_prod)

-- Cleaners (settings tab)
CREATE TABLE IF NOT EXISTS `cleaner` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-unit weekly cleaning config (which day + which cleaner)
CREATE TABLE IF NOT EXISTS `unit_cleaning_config` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `property_id` bigint NOT NULL,
  `unit_id` bigint NOT NULL,
  `cleaning_day` tinyint DEFAULT NULL COMMENT '0=Mon,1=Tue,2=Wed,3=Thu,4=Fri,5=Sat,6=Sun',
  `cleaner_id` bigint DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_unit` (`unit_id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_property_id` (`property_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Weekly overrides (skip or move day for a specific week)
CREATE TABLE IF NOT EXISTS `unit_cleaning_override` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `unit_id` bigint NOT NULL,
  `week_of` date NOT NULL COMMENT 'Monday of that week',
  `override_type` tinyint NOT NULL DEFAULT 0 COMMENT '0=skip, 1=move',
  `override_day` tinyint DEFAULT NULL COMMENT '0-6 Mon-Sun, only for type=1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_unit_week` (`unit_id`, `week_of`),
  KEY `idx_org_id` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Checkout cleaning per lease
CREATE TABLE IF NOT EXISTS `checkout_cleaning` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `lease_id` bigint NOT NULL,
  `tenant_id` bigint DEFAULT NULL,
  `property_id` bigint DEFAULT NULL,
  `unit_id` bigint DEFAULT NULL,
  `cleaning_date` date DEFAULT NULL,
  `cleaner_id` bigint DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT 0 COMMENT '0=pending, 1=completed',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lease` (`lease_id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_unit_id` (`unit_id`),
  KEY `idx_cleaning_date` (`cleaning_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generated weekly schedule (output of Generate button)
CREATE TABLE IF NOT EXISTS `cleaning_schedule` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `property_id` bigint DEFAULT NULL,
  `unit_id` bigint DEFAULT NULL,
  `cleaner_id` bigint DEFAULT NULL,
  `scheduled_date` date NOT NULL,
  `type` tinyint NOT NULL DEFAULT 0 COMMENT '0=weekly, 1=checkout',
  `lease_id` bigint DEFAULT NULL,
  `tenant_id` bigint DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT 0 COMMENT '0=pending, 1=completed',
  `week_of` date NOT NULL COMMENT 'Monday of the week this belongs to',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_week` (`org_id`, `week_of`),
  KEY `idx_scheduled_date` (`scheduled_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

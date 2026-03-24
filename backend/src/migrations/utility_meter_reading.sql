-- Utility meter reading log + master/sub-meter distinction
-- Run against each org database (e.g. tena_prod)

-- Add meter_category to utility_meter (0=master, 1=sub-meter)
ALTER TABLE `utility_meter`
  ADD COLUMN `meter_category` tinyint NOT NULL DEFAULT 1
  COMMENT '0=master meter, 1=tenant sub-meter'
  AFTER `meter_type`;

-- Meter reading log table
CREATE TABLE IF NOT EXISTS `utility_meter_reading` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `meter_id` bigint NOT NULL,
  `reading_value` decimal(12,2) NOT NULL,
  `reading_date` date NOT NULL,
  `reading_type` tinyint NOT NULL DEFAULT 2 COMMENT '0=move-in, 1=move-out, 2=billing',
  `tenant_id` bigint DEFAULT NULL,
  `bill_id` bigint DEFAULT NULL COMMENT 'populated when reading_type=2 (billing)',
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_meter_id` (`meter_id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_bill_id` (`bill_id`),
  KEY `idx_meter_date` (`meter_id`, `reading_date` DESC),
  KEY `idx_tenant_id` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed existing current_reading values into the reading log
INSERT INTO utility_meter_reading (id, org_id, meter_id, reading_value, reading_date, reading_type, notes, created_at)
SELECT
  FLOOR(UNIX_TIMESTAMP(NOW(6)) * 1000000 + FLOOR(RAND() * 1000000)),
  m.org_id, m.id, m.current_reading, CURDATE(), 2, 'Migrated from current_reading', NOW()
FROM utility_meter m
WHERE m.status = 1 AND m.current_reading > 0;

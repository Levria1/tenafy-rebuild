-- Booking Platform & Sales Agent Commission Tracking
-- Run against each org database

-- Booking platform lookup (e.g. Airbnb, Booking.com, Direct)
CREATE TABLE IF NOT EXISTS `booking_platform` (
  `id` bigint NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `org_id` bigint NOT NULL,
  `enabled` bit(1) DEFAULT b'1',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sales agent lookup (for commission tracking)
CREATE TABLE IF NOT EXISTS `sales_agent` (
  `id` bigint NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `org_id` bigint NOT NULL,
  `enabled` bit(1) DEFAULT b'1',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add columns to leasing
ALTER TABLE `leasing` ADD COLUMN `booking_platform_id` bigint DEFAULT NULL;
ALTER TABLE `leasing` ADD COLUMN `sales_agent_id` bigint DEFAULT NULL;

-- Add columns to invoice
ALTER TABLE `invoice` ADD COLUMN `booking_platform_id` bigint DEFAULT NULL;
ALTER TABLE `invoice` ADD COLUMN `sales_agent_id` bigint DEFAULT NULL;

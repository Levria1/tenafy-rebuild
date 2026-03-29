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

-- Add columns to leasing (safe re-run)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'booking_platform_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `leasing` ADD COLUMN `booking_platform_id` bigint DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'sales_agent_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `leasing` ADD COLUMN `sales_agent_id` bigint DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add columns to invoice (safe re-run)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'booking_platform_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `invoice` ADD COLUMN `booking_platform_id` bigint DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'sales_agent_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `invoice` ADD COLUMN `sales_agent_id` bigint DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

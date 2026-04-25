
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `activity_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `org_id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` enum('CREATE','UPDATE','DELETE') COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `details` json DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_created` (`org_id`,`created_at`),
  KEY `idx_user` (`user_id`),
  KEY `idx_entity` (`entity_type`,`entity_id`),
  KEY `idx_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `checkout_cleaning` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `lease_id` bigint NOT NULL,
  `tenant_id` bigint DEFAULT NULL,
  `property_id` bigint DEFAULT NULL,
  `unit_id` bigint DEFAULT NULL,
  `cleaning_date` date DEFAULT NULL,
  `cleaner_id` bigint DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '0' COMMENT '0=pending, 1=completed',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lease` (`lease_id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_unit_id` (`unit_id`),
  KEY `idx_cleaning_date` (`cleaning_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `checkout_notes` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `lease_id` bigint NOT NULL,
  `unit_id` bigint NOT NULL,
  `property_id` bigint NOT NULL,
  `old_code` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `new_code` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `assigned_user_id` bigint DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lease` (`lease_id`,`org_id`),
  KEY `idx_org` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `cleaner` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `cleaning_schedule` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `property_id` bigint DEFAULT NULL,
  `unit_id` bigint DEFAULT NULL,
  `cleaner_id` bigint DEFAULT NULL,
  `scheduled_date` date NOT NULL,
  `type` tinyint NOT NULL DEFAULT '0' COMMENT '0=weekly, 1=checkout',
  `lease_id` bigint DEFAULT NULL,
  `tenant_id` bigint DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '0' COMMENT '0=pending, 1=completed',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `cleaning_notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `week_of` date NOT NULL COMMENT 'Monday of the week this belongs to',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_week` (`org_id`,`week_of`),
  KEY `idx_scheduled_date` (`scheduled_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `cleaning_week_notes` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `property_id` bigint NOT NULL,
  `week_of` date NOT NULL,
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_prop_week` (`property_id`,`week_of`),
  KEY `idx_org_id` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `lead_source_setting` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `org_id` bigint NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_enabled` (`org_id`,`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `password_reset_token` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `code` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `used` tinyint NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_code` (`code`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `service_activity` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `service_id` bigint NOT NULL,
  `status` tinyint DEFAULT NULL,
  `activity_date` datetime DEFAULT NULL,
  `note` text COLLATE utf8mb4_unicode_ci,
  `created_by` bigint NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_service` (`service_id`,`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `unit_cleaning_override` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `unit_id` bigint NOT NULL,
  `week_of` date NOT NULL COMMENT 'Monday of that week',
  `override_type` tinyint NOT NULL DEFAULT '0' COMMENT '0=skip, 1=move',
  `override_day` tinyint DEFAULT NULL COMMENT '0-6 Mon-Sun, only for type=1',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_unit_week` (`unit_id`,`week_of`),
  KEY `idx_org_id` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_bill` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `total_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `total_kw` decimal(12,2) NOT NULL DEFAULT '0.00',
  `rate_per_kw` decimal(10,4) NOT NULL DEFAULT '0.0000',
  `status` tinyint NOT NULL DEFAULT '0' COMMENT '0=draft, 1=finalized',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_group_id` (`group_id`),
  KEY `idx_period` (`period_start`,`period_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_bill_line` (
  `id` bigint NOT NULL,
  `bill_id` bigint NOT NULL,
  `meter_id` bigint NOT NULL,
  `unit_id` bigint DEFAULT NULL,
  `tenant_id` bigint DEFAULT NULL,
  `leasing_id` bigint DEFAULT NULL,
  `starting_reading` decimal(12,2) NOT NULL DEFAULT '0.00',
  `ending_reading` decimal(12,2) NOT NULL DEFAULT '0.00',
  `kw_used` decimal(12,2) NOT NULL DEFAULT '0.00',
  `gross_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `utility_credit` decimal(10,2) NOT NULL DEFAULT '0.00' COMMENT 'Monthly credit from lease',
  `lease_start` date DEFAULT NULL,
  `lease_end` date DEFAULT NULL,
  `prorated_days` int DEFAULT NULL,
  `total_period_days` int DEFAULT NULL,
  `prorated_credit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `net_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `is_common_area` tinyint NOT NULL DEFAULT '0',
  `invoice_id` bigint DEFAULT NULL COMMENT 'NULL until invoice generated',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bill_id` (`bill_id`),
  KEY `idx_meter_id` (`meter_id`),
  KEY `idx_tenant_id` (`tenant_id`),
  KEY `idx_invoice_id` (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_checkout_settlement` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `meter_id` bigint NOT NULL,
  `tenant_id` bigint NOT NULL,
  `leasing_id` bigint NOT NULL,
  `starting_reading` decimal(12,2) NOT NULL DEFAULT '0.00',
  `checkout_reading` decimal(12,2) NOT NULL DEFAULT '0.00',
  `kw_used` decimal(12,2) NOT NULL DEFAULT '0.00',
  `rate_per_kw` decimal(10,4) NOT NULL DEFAULT '0.0000',
  `gross_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `utility_credit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `prorated_credit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `period_days` int DEFAULT NULL,
  `net_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `reading_date` date NOT NULL,
  `reading_id` bigint DEFAULT NULL,
  `invoice_id` bigint DEFAULT NULL,
  `next_lease_id` bigint DEFAULT NULL,
  `previous_meter_reading` decimal(12,2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_tenant_id` (`tenant_id`),
  KEY `idx_leasing_id` (`leasing_id`),
  KEY `idx_meter_id` (`meter_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_group` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `property_id` bigint DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '1=active, 0=deleted',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_property_id` (`property_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_meter` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  `unit_id` bigint DEFAULT NULL COMMENT 'NULL = common area meter',
  `meter_number` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `meter_type` tinyint NOT NULL DEFAULT '0' COMMENT '0=electric, 1=water, 2=gas',
  `meter_category` tinyint NOT NULL DEFAULT '1' COMMENT '0=master meter, 1=tenant sub-meter',
  `current_reading` decimal(12,2) NOT NULL DEFAULT '0.00',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '1=active, 0=deleted',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_group_id` (`group_id`),
  KEY `idx_unit_id` (`unit_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_meter_reading` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `meter_id` bigint NOT NULL,
  `reading_value` decimal(12,2) NOT NULL,
  `reading_date` date NOT NULL,
  `reading_type` tinyint NOT NULL DEFAULT '2' COMMENT '0=move-in, 1=move-out, 2=billing',
  `tenant_id` bigint DEFAULT NULL,
  `bill_id` bigint DEFAULT NULL COMMENT 'populated when reading_type=2 (billing)',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_meter_id` (`meter_id`),
  KEY `idx_org_id` (`org_id`),
  KEY `idx_bill_id` (`bill_id`),
  KEY `idx_meter_date` (`meter_id`,`reading_date` DESC),
  KEY `idx_tenant_id` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `utility_unit_group` (
  `unit_id` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  PRIMARY KEY (`unit_id`),
  KEY `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;


-- ─────────────────────────────────────────────────────────────────────────
-- Tenant column repairs
-- The org_schema_template was never updated when these were added via
-- separate migrations. Idempotent: information_schema check before ALTER.
-- ─────────────────────────────────────────────────────────────────────────
SET @dbname = DATABASE();

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'tenant' AND COLUMN_NAME = 'cleaning_notes');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE tenant ADD COLUMN cleaning_notes TEXT DEFAULT NULL AFTER notes', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'tenant' AND COLUMN_NAME = 'lead_source_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE tenant ADD COLUMN lead_source_id BIGINT DEFAULT NULL AFTER deleted_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

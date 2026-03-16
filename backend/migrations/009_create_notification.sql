-- Create notification table
CREATE TABLE IF NOT EXISTS `notification` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `user_id` bigint DEFAULT NULL,
  `type` varchar(50) NOT NULL DEFAULT 'info',
  `title` varchar(255) NOT NULL,
  `message` text,
  `link` varchar(500) DEFAULT NULL,
  `is_read` tinyint NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `read_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_notification_org` (`org_id`),
  KEY `idx_notification_user` (`user_id`),
  KEY `idx_notification_read` (`org_id`, `is_read`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

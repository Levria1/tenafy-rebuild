-- Migration 006: Create email_log table
-- Tracks all outbound emails for admin monitoring dashboard

CREATE TABLE IF NOT EXISTS `email_log` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `org_id`     BIGINT       DEFAULT NULL,
  `to_email`   VARCHAR(255) NOT NULL,
  `subject`    VARCHAR(500) DEFAULT NULL,
  `type`       VARCHAR(100) DEFAULT NULL COMMENT 'e.g. invoice, lease_expiry, overdue_reminder, invitation',
  `status`     VARCHAR(20)  NOT NULL DEFAULT 'sent' COMMENT 'sent, failed',
  `error`      LONGTEXT     DEFAULT NULL,
  `sent_at`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_email_log_org`  (`org_id`),
  KEY `idx_email_log_sent` (`sent_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Allow email templates to specify their own primary recipient (used by templates
-- not tied to a lease, e.g. Inquiry-Reminder).
SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_template' AND COLUMN_NAME = 'to_address');
SET @sql := IF(@col = 0, 'ALTER TABLE email_template ADD COLUMN to_address VARCHAR(500) DEFAULT NULL AFTER `from`', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

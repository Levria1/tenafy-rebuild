-- Inquiry: desired start date, budget, reminder date + sent timestamp.
-- Idempotent — safe to re-run.

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry' AND COLUMN_NAME = 'desired_start_date');
SET @sql := IF(@col = 0, 'ALTER TABLE inquiry ADD COLUMN desired_start_date DATE DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry' AND COLUMN_NAME = 'budget');
SET @sql := IF(@col = 0, 'ALTER TABLE inquiry ADD COLUMN budget DECIMAL(12,2) DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry' AND COLUMN_NAME = 'reminder_date');
SET @sql := IF(@col = 0, 'ALTER TABLE inquiry ADD COLUMN reminder_date DATE DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry' AND COLUMN_NAME = 'reminder_sent_at');
SET @sql := IF(@col = 0, 'ALTER TABLE inquiry ADD COLUMN reminder_sent_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry' AND INDEX_NAME = 'idx_reminder');
SET @sql := IF(@idx = 0, 'ALTER TABLE inquiry ADD INDEX idx_reminder (reminder_date, reminder_sent_at, deleted_at)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

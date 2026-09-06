-- 080_service_activity_soft_delete.sql (PER-ORG)
-- Deleting a timeline entry must be undoable, and must leave a record of what was said.
--
-- Deleting stays permitted: staff tidy up mistakes and duplicates, and taking that away
-- would break a habit people rely on. What changes is that it stops being destructive.
-- The row is marked deleted rather than removed, so it can be put back, and the full text
-- is copied into activity_log at the moment of deletion, so even a later hard purge of
-- this table leaves evidence of what the entry said and who removed it.
--
-- Guarded on the table existing, like 079: the TaneChat test org has `service` but no
-- `service_activity`, and a migration that fails there on every run is how a real failure
-- gets scrolled past.
SET @has_table := (SELECT COUNT(*) FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity');

-- NULL means live. Every one of the existing rows keeps that, so nothing disappears from
-- a timeline the moment this runs.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity' AND COLUMN_NAME = 'deleted_at');
SET @s := IF(@has_table = 1 AND @c = 0, 'ALTER TABLE service_activity ADD COLUMN deleted_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Who removed it. activity_log records this too, but keeping it on the row means the
-- restore screen can say who deleted it without a second lookup.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity' AND COLUMN_NAME = 'deleted_by');
SET @s := IF(@has_table = 1 AND @c = 0, 'ALTER TABLE service_activity ADD COLUMN deleted_by BIGINT NULL AFTER deleted_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

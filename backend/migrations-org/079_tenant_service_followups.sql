-- 079_tenant_service_followups.sql (PER-ORG)
-- Lets a tenant add to a repair request they have already filed, and withdraw one
-- nobody has started.
--
-- WHY APPEND AND NOT EDIT
--
-- The obvious feature is an edit button. It is the wrong one. Once staff have read a
-- request and booked a vendor against it, a tenant rewriting the description leaves the
-- vendor arriving for a job that no longer exists, with nothing in the record showing it
-- changed. A repair request is a report of something that happened, so the honest model
-- is a thread you add to, never a document that is quietly revised. Cancelling is
-- restricted further, to requests still sitting at Received, because withdrawing work
-- that is already underway is a conversation, not a button.
--
-- WHY service_activity AND NOT A NEW TABLE
--
-- Staff already read this table as the timeline on the request. Putting tenant follow-ups
-- anywhere else would mean whoever picks up the job has two places to look and no reason
-- to remember the second one.

-- EVERY STATEMENT BELOW IS GUARDED ON THE TABLE EXISTING.
--
-- The TaneChat test org has `service` but no `service_activity` (98 tables, an
-- incomplete schema). Without this guard 079 fails there on every migration run
-- forever, and a permanent red line is how a real failure goes unnoticed.
SET @has_table := (SELECT COUNT(*) FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity');

-- created_by holds a STAFF user id and is NOT NULL. A tenant follow-up has no staff
-- author, and writing 0 there would be a lie that every LEFT JOIN silently accepts.
-- Nullable is the honest shape: absent, not zero.
SET @c := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity'
              AND COLUMN_NAME = 'created_by');
SET @s := IF(@has_table = 1 AND @c = 'NO', 'ALTER TABLE service_activity MODIFY created_by BIGINT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Which side wrote the row. NULL means staff, matching every one of the 419 rows that
-- already exist and keeping them internal by default, exactly as object_file.source does
-- for attachments. The tenant portal only ever returns rows where this is 'tenant', so a
-- staff note about a vendor's pricing cannot appear on a tenant's screen.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity' AND COLUMN_NAME = 'source');
SET @s := IF(@has_table = 1 AND @c = 0, 'ALTER TABLE service_activity ADD COLUMN source VARCHAR(16) NULL AFTER created_by', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Which tenant record wrote it. A person can hold several tenant rows across tenancies,
-- and attributing a follow-up to whichever sorted first misidentifies the author on a
-- request that may outlive the tenancy.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity' AND COLUMN_NAME = 'created_by_tenant');
SET @s := IF(@has_table = 1 AND @c = 0, 'ALTER TABLE service_activity ADD COLUMN created_by_tenant BIGINT NULL AFTER source', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_activity' AND INDEX_NAME = 'idx_service_activity_service');
SET @s := IF(@has_table = 1 AND @c = 0, 'ALTER TABLE service_activity ADD KEY idx_service_activity_service (service_id, created_at)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

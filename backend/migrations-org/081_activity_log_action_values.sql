-- 081_activity_log_action_values.sql (PER-ORG)
-- The audit log has been silently refusing most of what it was asked to record.
--
-- WHAT WAS HAPPENING
--
-- `action` is ENUM('CREATE','UPDATE','DELETE'). The code passes ten more values —
-- CONFIRM, MOVE_OUT, EMAIL, CANCEL, RESTORE, RESEND, PUBLISH, WRITE_OFF,
-- LINK_CONTACT, DUPLICATE. MySQL rejects each insert with "Data truncated for
-- column 'action'", and logActivity catches the error so the request succeeds
-- anyway. All 4,020 rows on the live database are CREATE, UPDATE or DELETE.
-- Nothing else has ever been written.
--
-- The cost is not cosmetic. "Who confirmed this lease?" was supposed to be
-- answerable and is not, and neither is who emailed check-in details, who moved a
-- tenant out, or who restored a deleted timeline entry. The feature was built,
-- shipped, and reported as working, and the evidence of its failure went to a log
-- file instead of to anyone who could act on it.
--
-- WHY AN ENUM AT ALL
--
-- Kept rather than widened to VARCHAR: idx_action exists so the log can be
-- filtered by action, and an enum is what stops a typo becoming a third spelling
-- of DELETE that no filter will ever match. utils/activityLog.js holds the same
-- list as ACTIONS, and a test fails if the two drift or if code introduces a
-- value that is in neither.
--
-- GUARDED ON THE TABLE EXISTING. Not every org database carries activity_log,
-- and a migration that fails forever on one org is how a real failure stops being
-- noticed.
SET @has_table := (SELECT COUNT(*) FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activity_log');

-- Existing rows all hold CREATE/UPDATE/DELETE, which keep their positions at the
-- head of the list, so no stored value is reinterpreted by the widening.
SET @s := IF(@has_table = 1,
  'ALTER TABLE activity_log MODIFY action ENUM(
     ''CREATE'',''UPDATE'',''DELETE'',
     ''CONFIRM'',''CANCEL'',''MOVE_OUT'',
     ''EMAIL'',''RESEND'',''PUBLISH'',
     ''RESTORE'',''WRITE_OFF'',''LINK_CONTACT'',''DUPLICATE''
   ) COLLATE utf8mb4_unicode_ci NOT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

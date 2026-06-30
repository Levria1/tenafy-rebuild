-- 013_viewing_invite_prefill_times.sql  (PER-ORG)
-- The TaneChat bot parses a prospect's free-text reply ("Thursday 3pm or Friday
-- morning") into concrete times, then calls POST /api/public/viewing-request.
-- We mint an invite pre-loaded with those parsed times and hand back a REVIEW
-- link: the prospect opens it, the times are pre-filled, and they can correct
-- any mis-parse before submitting (which is what finally notifies the tenant).
--
-- prefill_times: JSON array of 'YYYY-MM-DDTHH:mm:ss' strings (null for the
-- plain single-date prefill path).
--
-- Idempotent: information_schema-guarded.

SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_invite' AND COLUMN_NAME = 'prefill_times');
SET @ddl1 := IF(@c1 = 0,
  'ALTER TABLE viewing_invite ADD COLUMN prefill_times TEXT NULL DEFAULT NULL AFTER prefill_date',
  'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

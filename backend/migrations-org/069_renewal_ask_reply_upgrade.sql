-- 069_renewal_ask_reply_upgrade.sql  (PER-ORG)
-- A vague reply may be superseded by a real one. A real one is final.
--
-- Why this exists: the relay cannot tell a tenant's answer from an unrelated message,
-- and deliberately does not try — having a model decide what a tenant meant about their
-- own lease is a guess we refuse to make. So the ask may land while the tenant is
-- mid-conversation about something else, and their next message ("ok thanks") is relayed
-- as the answer. Classified conservatively, that becomes `unsure`.
--
-- Before this change the first relay was final: the real answer thirty seconds later was
-- discarded, the ask sequence stopped, and no escalation fired — the tenant simply went
-- quiet in our records. Now an `unsure` reply may be replaced by `extend` or `leaving`.
--
-- The reverse is deliberately impossible. A definite answer can never be overwritten,
-- because the dangerous direction is the one that puts a home back on the market: a
-- stray later message must not undo a tenant's "we're staying".
--
-- Only one upgrade can ever happen (unsure -> definite, and definite is final), so a
-- single slot is enough to keep the superseded reply. We keep it rather than overwrite
-- because a tenant took the trouble to send it, and staff reading the row later need to
-- see what we originally filed.
--
-- Idempotent: guarded by information_schema, like 064-068.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'prior_reply_intent');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN prior_reply_intent TINYINT DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'prior_reply_text');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN prior_reply_text TEXT DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'prior_replied_at');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN prior_replied_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

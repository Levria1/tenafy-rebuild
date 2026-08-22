-- 075_renewal_unverified_reply.sql (PER-ORG)
-- "The tenant has probably answered, but we cannot attribute it confidently."
--
-- Distinct from reply_intent=3 (unsure). Unsure means the TENANT has not decided,
-- so the sequence keeps asking — that is correct and deliberate. This means WE are
-- not sure the message is an answer at all: it arrived in a group thread, or was
-- forwarded, or the wording is ambiguous in a way only the conversation reveals.
-- Asking again would nag someone who did answer; acting would be a lease decision
-- taken on evidence nobody trusts. So it holds the sequence and asks a human.
--
-- Kept in its own columns rather than overloading reply_intent/reply_text: those
-- are the answer of record, and a value we do not trust must never be able to
-- masquerade as one.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='renewal_ask' AND COLUMN_NAME='unverified_at');
SET @s := IF(@c=0, 'ALTER TABLE renewal_ask ADD COLUMN unverified_at DATETIME NULL AFTER prior_replied_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='renewal_ask' AND COLUMN_NAME='unverified_text');
SET @s := IF(@c=0, 'ALTER TABLE renewal_ask ADD COLUMN unverified_text TEXT NULL AFTER unverified_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Who captured it, so a hold can be traced back to the system that placed it.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='renewal_ask' AND COLUMN_NAME='unverified_by');
SET @s := IF(@c=0, 'ALTER TABLE renewal_ask ADD COLUMN unverified_by VARCHAR(32) NULL AFTER unverified_text', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

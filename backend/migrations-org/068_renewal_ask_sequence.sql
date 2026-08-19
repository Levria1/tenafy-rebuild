-- 068_renewal_ask_sequence.sql  (PER-ORG)
-- Up to three renewal asks per decision cycle, then escalate to staff.
--
-- 067 allowed exactly one ask per cycle. The operator wants three, spaced out, and a
-- hand-off to a human if all three go unanswered — silence is not an answer, and it is
-- not "leaving" either.
--
-- The cooldown key therefore gains ask_number: still one row per (lease, cycle, ask),
-- so a retry cannot produce a fourth message, but three are now legitimate.
--
-- Terminology: reply_intent 1 is EXTEND (was "staying" in 067) to match the operator's
-- wording. The numeric value is unchanged, so no data migration is needed.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'ask_number');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN ask_number TINYINT NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'channel');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN channel VARCHAR(16) DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'escalated_at');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN escalated_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'send_error');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN send_error VARCHAR(255) DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Replace the one-ask-per-cycle key with one-ask-per-cycle-PER-NUMBER.
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND INDEX_NAME = 'uk_renewal_ask_cycle');
SET @s := IF(@c > 0, 'ALTER TABLE renewal_ask DROP INDEX uk_renewal_ask_cycle', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND INDEX_NAME = 'uk_renewal_ask_cycle_n');
SET @s := IF(@c = 0,
  'ALTER TABLE renewal_ask ADD UNIQUE KEY uk_renewal_ask_cycle_n (lease_id, lease_end_at_ask, decision_due_on, ask_number)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- How many delivery attempts this ask row has had. A send that fails, or dies mid-flight,
-- must not strand the tenant: the row is retried, and after the cap it is marked FAILED so
-- the sequence can move on and staff are told, rather than the lease going silent forever.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'attempts');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN attempts TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'renewal_ask' AND COLUMN_NAME = 'resolved_on');
SET @s := IF(@c = 0, 'ALTER TABLE renewal_ask ADD COLUMN resolved_on DATE DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Days between consecutive asks. The 24-hour floor is enforced in code regardless, so
-- setting this to 0 cannot produce two messages in one day.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_ask_gap_days');
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_ask_gap_days SMALLINT NOT NULL DEFAULT 3', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Asks 2 and 3 are separately authored: ask 2 may mention that a prospect is
-- interested, ask 1 deliberately does not.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_ask_phrase_2');
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_ask_phrase_2 TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_ask_phrase_3');
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_ask_phrase_3 TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE advertising_setting
   SET renewal_ask_phrase_2 = 'Hi {tenant_name}, following up on {unit} — your lease runs to {end_date}. Someone has asked about the unit, so we would like to know whether you are planning to stay on before we reply to them. Could you let us know either way?'
 WHERE renewal_ask_phrase_2 IS NULL;

UPDATE advertising_setting
   SET renewal_ask_phrase_3 = 'Hi {tenant_name}, we have not managed to reach you about {unit}, where your lease runs to {end_date}. Could you let us know whether you plan to stay on? If we do not hear back, a member of our team will call you.'
 WHERE renewal_ask_phrase_3 IS NULL;

-- Per-org migration: send-mode protocol metadata on viewing negotiation events.
--
-- send_mode separates auto-sendable events from staff approval drafts. event_type
-- is added alongside template_type because template_type names the wording (an org
-- can customise it), while event_type names the protocol meaning that TaneChat's
-- auto-send allowlist keys off. Two templates could share an event type, and an
-- org renaming a template must not silently drop an event out of the allowlist.
--
-- uk_vne_idem is unique on idempotency_key. MySQL permits multiple NULL values in
-- a unique index, so legacy rows without a key are unaffected.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation_event'
     AND COLUMN_NAME = 'send_mode');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation_event ADD COLUMN send_mode VARCHAR(16) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation_event'
     AND COLUMN_NAME = 'event_type');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation_event ADD COLUMN event_type VARCHAR(48) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation_event'
     AND COLUMN_NAME = 'idempotency_key');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation_event ADD COLUMN idempotency_key VARCHAR(128) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation_event'
     AND COLUMN_NAME = 'deadline_at');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation_event ADD COLUMN deadline_at DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation_event'
     AND INDEX_NAME = 'uk_vne_idem');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation_event ADD UNIQUE KEY uk_vne_idem (idempotency_key)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

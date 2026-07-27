-- 025_viewing_negotiation_event_message_id.sql  (PER-ORG)
-- Viewing Relay Scheduler — idempotency for inbound replies.
--
-- TaneChat may resend the same reply (duplicate/echo inbound, or a retried POST).
-- It now passes its WhatsApp `message_id` on the reply endpoints; we store it
-- here and no-op a repeat for the same negotiation so the state machine can't
-- double-advance. Nullable — replies without an id are simply not deduped.
--
-- Idempotent: information_schema-guarded ALTER.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation_event'
     AND COLUMN_NAME = 'client_message_id');
SET @ddl := IF(@c = 0,
  'ALTER TABLE viewing_negotiation_event
     ADD COLUMN client_message_id VARCHAR(128) NULL DEFAULT NULL,
     ADD KEY idx_vne_client_msg (negotiation_id, client_message_id)',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

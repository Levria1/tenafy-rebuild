-- 022_viewing_negotiation_event.sql  (PER-ORG)
-- Viewing Relay Scheduler — the message log AND the staff-approval queue.
--
-- Every inbound (parsed reply from prospect/tenant) and outbound (templated
-- message Tenafy sends) is one row. Outbound rows carry the render:
--   - relay_mode='auto'   → inserted status='sent' right after the gateway send
--   - relay_mode='manual' → inserted status='draft'; staff release it from the
--                           dashboard, which sends via the gateway + flips to 'sent'
-- intent = the structured JSON TaneChat posted ({date,time} | {accepted,counter} | {cancel}).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS viewing_negotiation_event (
  id              BIGINT       NOT NULL PRIMARY KEY,
  negotiation_id  BIGINT       NOT NULL,
  direction       VARCHAR(8)   NOT NULL,             -- in | out
  party           VARCHAR(16)  NOT NULL,             -- prospect | tenant | staff | system
  to_phone        VARCHAR(64)  DEFAULT NULL,         -- outbound recipient (for the gateway send)
  template_type   VARCHAR(64)  DEFAULT NULL,         -- outbound only
  body            TEXT         DEFAULT NULL,          -- rendered/plain message text
  intent          JSON         DEFAULT NULL,          -- inbound structured signal
  status          VARCHAR(16)  NOT NULL DEFAULT 'sent', -- draft | sent
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         TIMESTAMP    NULL DEFAULT NULL,
  KEY idx_vne_negotiation (negotiation_id),
  KEY idx_vne_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 021_viewing_negotiation.sql  (PER-ORG)
-- Viewing Relay Scheduler — the state-machine row.
--
-- One row per "Schedule Viewing" press. Tenafy runs a conversational relay: it
-- asks the prospect for a day, checks the responsible staffer's Google calendar,
-- asks the tenant (via WhatsApp) whether that time works, and shuttles counter-
-- offers between the two until they agree, then confirms via the existing
-- viewing_booking + Google Calendar + .ics path (booking_id set on CONFIRMED).
--
-- state:
--   ASK_PROSPECT_DAY | CHECK_STAFF | AWAIT_TENANT | ASK_TENANT_ALT |
--   RELAY_TO_PROSPECT | CONFIRMED | NEEDS_STAFF | CANCELLED
-- awaiting: prospect | tenant | staff | NULL  (drives the dashboard "waiting on")
-- proposed_by: prospect | tenant  (who last proposed current_proposed_datetime)
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS viewing_negotiation (
  id                        BIGINT       NOT NULL PRIMARY KEY,
  unit_id                   BIGINT       NOT NULL,
  property_id               BIGINT       NOT NULL,
  lease_id                  BIGINT       DEFAULT NULL,   -- NULL = vacant unit (host prompted, no tenant)
  tenant_id                 BIGINT       DEFAULT NULL,
  inquiry_id                BIGINT       DEFAULT NULL,
  prospect_name             VARCHAR(255) DEFAULT NULL,
  prospect_phone            VARCHAR(64)  DEFAULT NULL,
  prospect_email            VARCHAR(255) DEFAULT NULL,
  staff_employee_id         BIGINT       DEFAULT NULL,   -- resolved staff-of-day for current proposed date
  state                     VARCHAR(32)  NOT NULL DEFAULT 'ASK_PROSPECT_DAY',
  current_proposed_datetime DATETIME     DEFAULT NULL,
  proposed_by               VARCHAR(16)  DEFAULT NULL,
  round_count               INT          NOT NULL DEFAULT 0,
  awaiting                  VARCHAR(16)  DEFAULT NULL,
  booking_id                BIGINT       DEFAULT NULL,   -- set on CONFIRMED
  created_at                TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  closed_at                 TIMESTAMP    NULL DEFAULT NULL,
  KEY idx_vn_state (state),
  KEY idx_vn_phone_state (prospect_phone, state),
  KEY idx_vn_unit (unit_id),
  KEY idx_vn_awaiting (awaiting)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

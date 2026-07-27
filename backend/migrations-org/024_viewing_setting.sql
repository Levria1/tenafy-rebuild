-- 024_viewing_setting.sql  (PER-ORG)
-- Viewing Relay Scheduler — org-wide settings (one row per org).
--
-- relay_mode:  manual = every outbound message waits for staff approval on the
--              dashboard before it is sent; auto = the bot sends immediately.
--              Ships MANUAL — staff flip to auto once they trust it.
-- max_rounds:  after this many counter-offers (from either side) with no
--              agreement, the negotiation escalates to NEEDS_STAFF (no loops).
-- viewing_days/start/end: the offerable window (0=Sun .. 6=Sat), default Mon–Sat
--              11:00–19:00 (previously hardcoded).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS viewing_setting (
  org_id        BIGINT       NOT NULL PRIMARY KEY,
  relay_mode    VARCHAR(16)  NOT NULL DEFAULT 'manual',   -- manual | auto
  max_rounds    INT          NOT NULL DEFAULT 3,
  viewing_days  VARCHAR(20)  NOT NULL DEFAULT '1,2,3,4,5,6',
  viewing_start TIME         NOT NULL DEFAULT '11:00:00',
  viewing_end   TIME         NOT NULL DEFAULT '19:00:00',
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

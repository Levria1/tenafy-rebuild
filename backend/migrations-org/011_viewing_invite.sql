-- 011_viewing_invite.sql  (PER-ORG)
-- Per-prospect, prefilled, short-lived viewing links. The TaneChat bot calls
-- POST /api/public/viewing-link → we mint a row here and return its URL. Solves
-- the "shared per-unit link lives forever" problem: each prospect gets their own
-- expiring token, and it only mints while the unit is open for viewings.
--
-- Token is also registered in master tena_master.viewing_link_registry (kind=4)
-- so the public middleware can resolve the org without auth.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS viewing_invite (
  id              BIGINT       NOT NULL PRIMARY KEY,
  token           VARCHAR(80)  NOT NULL,
  unit_id         BIGINT       NOT NULL,
  property_id     BIGINT       NULL,
  employee_id     BIGINT       NULL,
  leasing_id      BIGINT       NULL,          -- the departing lease that's open for viewings
  prospect_name   VARCHAR(255) NULL,
  prospect_phone  VARCHAR(64)  NULL,
  prospect_email  VARCHAR(255) NULL,
  prefill_date    DATE         NULL,          -- the day the prospect named in chat
  expires_at      DATETIME     NOT NULL,
  status          TINYINT      NOT NULL DEFAULT 1,  -- 1=active, 0=used/revoked/expired
  booking_id      BIGINT       NULL,          -- set once the prospect submits a request
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_viewing_invite_token (token),
  KEY idx_viewing_invite_unit (unit_id),
  KEY idx_viewing_invite_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 067_renewal_ask.sql  (PER-ORG)
-- Demand-triggered renewal ask: when a prospect wants a unit whose tenant has not
-- said whether they are staying, ask the tenant.
--
-- Two stores, deliberately:
--   renewal_ask          — the audit trail. One row per ask, per lease, per cycle.
--   leasing.renewal_reply — the fast fact the vacancy query reads, so the hot path
--                           does not join a history table on every request.
--
-- renewal_reply: NULL = never asked/answered, 1 = staying, 2 = leaving, 3 = unsure.
-- Only 1 (staying) has an automatic effect, and only in the conservative direction:
-- it WITHDRAWS the unit from customer-facing feeds. A reply never marks a unit
-- firmly available — evidence good enough to stop us selling is not good enough to
-- let us sell, because a tenant who says "probably leaving" may still stay.
--
-- Idempotent: guarded by information_schema, like 064/065/066.

CREATE TABLE IF NOT EXISTS renewal_ask (
  id                  BIGINT       NOT NULL PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  lease_id            BIGINT       NOT NULL,
  unit_id             BIGINT       NOT NULL,
  tenant_id           BIGINT       DEFAULT NULL,
  -- The cycle this ask belongs to. Both are stamped at creation so a lease that is
  -- later extended, or whose notice period is corrected, starts a NEW cycle instead
  -- of being silently suppressed by the previous cycle's cooldown.
  lease_end_at_ask    DATE         NOT NULL,
  decision_due_on     DATE         NOT NULL,
  state               VARCHAR(16)  NOT NULL DEFAULT 'PENDING',  -- PENDING|SENT|REPLIED|NO_REPLY|CANCELLED
  message             TEXT         DEFAULT NULL,                -- rendered at creation, so what we asked is auditable
  triggered_by        VARCHAR(32)  DEFAULT NULL,                -- 'inquiry' | 'staff'
  -- Snapshot of the renewal intent when we asked. Without it, a reply arriving after
  -- staff re-typed the lease would be compared against the lease's CURRENT value —
  -- i.e. against itself — and the change would never be detected.
  contract_type_at_ask TINYINT     DEFAULT NULL,
  -- Claimed by a poller. Two workers (or a retry) must not both send the same ask to
  -- a real tenant, so /pending hands a row out once and only re-offers it if the
  -- claim goes stale.
  claimed_at          DATETIME     DEFAULT NULL,
  claim_token         VARCHAR(32)  DEFAULT NULL,
  sent_at             DATETIME     DEFAULT NULL,
  replied_at          DATETIME     DEFAULT NULL,
  reply_intent        TINYINT      DEFAULT NULL,                -- 1 staying, 2 leaving, 3 unsure
  reply_text          TEXT         DEFAULT NULL,
  applied             TINYINT      NOT NULL DEFAULT 0,          -- 0 = recorded but not acted on (stale reply)
  stale_reason        VARCHAR(64)  DEFAULT NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_renewal_ask_org (org_id),
  KEY idx_renewal_ask_unit (unit_id),
  KEY idx_renewal_ask_state (org_id, state),
  -- The cooldown key. One live ask per lease per cycle; a new cycle is a new row.
  UNIQUE KEY uk_renewal_ask_cycle (lease_id, lease_end_at_ask, decision_due_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'renewal_reply');
SET @s := IF(@c = 0, 'ALTER TABLE leasing ADD COLUMN renewal_reply TINYINT NULL DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leasing' AND COLUMN_NAME = 'renewal_reply_at');
SET @s := IF(@c = 0, 'ALTER TABLE leasing ADD COLUMN renewal_reply_at DATETIME NULL DEFAULT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Off by default. This feature messages real tenants about their own homes, so it
-- must never switch itself on by being deployed.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_ask_enabled');
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_ask_enabled TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_default_notice_days');
-- 45 is the operator's standard notice period. Verified on 2026-08-19 that this column
-- does not yet exist on any org, so every row is created with 45; the guard therefore
-- cannot leave an older 30 in place. If that ever changes, an org's stored value wins on
-- purpose — it may have been set deliberately.
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_default_notice_days SMALLINT NOT NULL DEFAULT 45', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting' AND COLUMN_NAME = 'renewal_ask_phrase');
SET @s := IF(@c = 0, 'ALTER TABLE advertising_setting ADD COLUMN renewal_ask_phrase TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- MySQL cannot DEFAULT a TEXT column, so seed it. Deliberately does NOT mention that
-- someone else is interested: that turns a routine admin question into pressure.
UPDATE advertising_setting
   SET renewal_ask_phrase = 'Hi {tenant_name}, your lease at {unit} runs to {end_date}. Are you planning to stay on? Just let us know either way and we''ll take care of the paperwork.'
 WHERE renewal_ask_phrase IS NULL;

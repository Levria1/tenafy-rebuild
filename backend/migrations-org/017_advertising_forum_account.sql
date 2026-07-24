-- Per-org migration: Facebook forums (groups) + posting accounts + membership.
-- The Scheduler's posting-plan pairs a forum with an account that is a MEMBER of
-- it (advertising_forum_account) so it never assigns an account to a group it
-- can't post in. Idempotent: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS advertising_forum (
  id          BIGINT       NOT NULL,
  org_id      BIGINT       NOT NULL,
  name        VARCHAR(255) NOT NULL,            -- e.g. "Find A Room In Hong Kong"
  url         VARCHAR(500) DEFAULT NULL,        -- the Facebook group URL
  notes       TEXT         DEFAULT NULL,
  status      TINYINT      NOT NULL DEFAULT 1,  -- 1=active 0=archived
  deleted_at  TIMESTAMP    NULL DEFAULT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adforum_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS advertising_account (
  id          BIGINT       NOT NULL,
  org_id      BIGINT       NOT NULL,
  name        VARCHAR(160) DEFAULT NULL,        -- Facebook display/username (placeholder; mapped later)
  email       VARCHAR(255) DEFAULT NULL,        -- the account login email
  notes       TEXT         DEFAULT NULL,
  status      TINYINT      NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMP    NULL DEFAULT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adaccount_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Membership: which accounts can post to which forum (many-to-many).
CREATE TABLE IF NOT EXISTS advertising_forum_account (
  id          BIGINT    NOT NULL,
  org_id      BIGINT    NOT NULL,
  forum_id    BIGINT    NOT NULL,
  account_id  BIGINT    NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_forum_account (forum_id, account_id),
  KEY idx_afa_org (org_id),
  KEY idx_afa_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

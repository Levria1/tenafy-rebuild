-- Per-org migration: manual "Urgent" scheduler entries.
-- The numbered 1..20 scheduler list is auto-generated from vacancy data (rolling);
-- Urgent entries are added by hand for extra posting priority and carry their own
-- forum rule (forum wiring lands once the forum list is defined — kept nullable).
-- Idempotent: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS advertising_urgent (
  id           BIGINT       NOT NULL,
  org_id       BIGINT       NOT NULL,
  property_id  BIGINT       DEFAULT NULL,        -- property this urgent posting is for
  unit_ids     TEXT         DEFAULT NULL,        -- JSON array of unit ids (bundled)
  label        VARCHAR(255) DEFAULT NULL,        -- free-text label shown in the list
  forum_rule   VARCHAR(500) DEFAULT NULL,        -- which forum/account to post to (own rule)
  note         TEXT         DEFAULT NULL,
  position     INT          NOT NULL DEFAULT 0,  -- ordering among urgent entries
  status       TINYINT      NOT NULL DEFAULT 1,
  deleted_at   TIMESTAMP    NULL DEFAULT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adurgent_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

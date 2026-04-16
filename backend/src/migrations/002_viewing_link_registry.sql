-- Master-level registry that maps a public/action/manage token to its owning org.
-- Used by backend/src/middleware/viewingTokenAuth.js to resolve req.pool for the
-- public viewing-booking surface WITHOUT a JWT cookie or API key.
--
-- `kind` values:
--   1 = link    (shareable per-unit URL token, prefix vbk_)
--   2 = action  (tenant or employee approve/decline token, emailed only)
--   3 = manage  (viewer self-cancel token, emailed only)

USE tena_master;

CREATE TABLE IF NOT EXISTS viewing_link_registry (
  token      VARCHAR(64) NOT NULL,
  org_id     BIGINT      NOT NULL,
  kind       TINYINT     NOT NULL,
  status     TINYINT     NOT NULL DEFAULT 1,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token),
  KEY idx_vlr_org (org_id),
  KEY idx_vlr_kind_status (kind, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

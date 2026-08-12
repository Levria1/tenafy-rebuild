-- Per-org migration: viewing access policy for the current unit occupant.
--
-- The design doc B5 says TaneChat stores this policy. It belongs here instead,
-- keyed by (unit_id, tenant_id), because the doc also requires the policy to reset
-- when the tenant changes, and TaneChat has no visibility of tenancy changes.
-- Tenafy owns tenancy, so Tenafy owns the policy. The composite key gives the
-- reset for free: a new tenant in the same unit is a different row, so the
-- previous occupant's "I need 24 hours' notice" cannot silently apply to someone
-- else. TaneChat may still pass a policy object at negotiation start, which wins
-- for that negotiation only.

CREATE TABLE IF NOT EXISTS viewing_access_policy (
  unit_id                BIGINT      NOT NULL,
  tenant_id              BIGINT      NOT NULL,
  opt_out_window_hours   SMALLINT    NULL,
  require_explicit_confirmation TINYINT NOT NULL DEFAULT 0,
  note                   VARCHAR(255) NULL,
  updated_by             BIGINT      NULL,
  created_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (unit_id, tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

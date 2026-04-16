-- Per-org viewing booking — one row per submission from the public form.
--
-- tenant_decision / employee_decision:
--   0 = pending, 1 = approved, 2 = declined, 3 = skipped (vacant unit, no tenant)
--
-- status:
--   0 = pending (awaiting approvals)
--   1 = confirmed (both approved; ICS sent)
--   2 = declined (either party declined)
--   3 = cancelled (viewer cancelled via manage link)
--   4 = expired

CREATE TABLE IF NOT EXISTS viewing_booking (
  id                     BIGINT       NOT NULL,
  link_id                BIGINT       NOT NULL,
  unit_id                BIGINT       NOT NULL,
  property_id            BIGINT       NOT NULL,
  employee_id            BIGINT       NOT NULL,
  leasing_id             BIGINT       DEFAULT NULL,
  tenant_id              BIGINT       DEFAULT NULL,
  viewer_name            VARCHAR(255) NOT NULL,
  viewer_email           VARCHAR(255) NOT NULL,
  viewer_phone           VARCHAR(64)  DEFAULT NULL,
  viewer_message         TEXT         DEFAULT NULL,
  proposed_datetime      DATETIME     NOT NULL,
  duration_minutes       INT          NOT NULL DEFAULT 30,
  tenant_action_token    VARCHAR(64)  DEFAULT NULL,
  employee_action_token  VARCHAR(64)  NOT NULL,
  viewer_manage_token    VARCHAR(64)  NOT NULL,
  tenant_decision        TINYINT      NOT NULL DEFAULT 0,
  tenant_decided_at      TIMESTAMP    NULL DEFAULT NULL,
  employee_decision      TINYINT      NOT NULL DEFAULT 0,
  employee_decided_at    TIMESTAMP    NULL DEFAULT NULL,
  status                 TINYINT      NOT NULL DEFAULT 0,
  ics_uid                VARCHAR(128) NOT NULL,
  created_at             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_vb_tenant_tok (tenant_action_token),
  UNIQUE KEY uk_vb_employee_tok (employee_action_token),
  UNIQUE KEY uk_vb_manage_tok (viewer_manage_token),
  KEY idx_vb_link (link_id),
  KEY idx_vb_unit_when (unit_id, proposed_datetime),
  KEY idx_vb_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

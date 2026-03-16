CREATE TABLE IF NOT EXISTS smtp_account (
  id          BIGINT       NOT NULL,
  org_id      BIGINT       NOT NULL,
  email       VARCHAR(255) NOT NULL,
  password    VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) DEFAULT NULL,
  host        VARCHAR(255) DEFAULT 'smtp.titan.email',
  port        INT          DEFAULT 465,
  is_secure   BIT(1)       DEFAULT 1,
  is_default  BIT(1)       DEFAULT 0,
  status      TINYINT      DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_smtp_account_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

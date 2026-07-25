-- Per-org migration: org-wide Advertising settings (one row per org).
-- footer = the shared closing appended to every post; photo_root = where the PC
-- agent finds images. Idempotent: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS advertising_setting (
  org_id      BIGINT       NOT NULL,
  footer      TEXT         DEFAULT NULL,
  photo_root  VARCHAR(255) DEFAULT NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

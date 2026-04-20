-- Migration 026: Create password_reset_token table
--
-- Stores short-lived 6-digit codes for the "Forgot Password?" flow.
-- Referenced by backend/src/routes/auth.js. Existed on local dev DB but
-- never had a migration — this creates it on prod + any fresh orgs.

CREATE TABLE IF NOT EXISTS password_reset_token (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT       NOT NULL,
  code       VARCHAR(10)  NOT NULL,
  expires_at DATETIME     NOT NULL,
  used       TINYINT      NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_code    (code),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

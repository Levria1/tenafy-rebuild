CREATE TABLE IF NOT EXISTS xero_payment_slip (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  org_id BIGINT NOT NULL,
  sha256 BINARY(32) NOT NULL,
  file_name VARCHAR(180) NOT NULL,
  mime_type VARCHAR(30) NOT NULL,
  original LONGBLOB NOT NULL,
  source_channel ENUM('email','whatsapp','other') NOT NULL,
  source_reference VARCHAR(255) NULL,
  ocr_state ENUM('pending','extracted','needs_review') NOT NULL DEFAULT 'pending',
  ocr_text TEXT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount_minor BIGINT UNSIGNED NULL,
  transfer_date DATE NULL,
  payer VARCHAR(180) NULL,
  transfer_reference VARCHAR(180) NULL,
  imported_by BIGINT NOT NULL,
  verified_by BIGINT NULL,
  verified_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id,id),
  UNIQUE KEY uq_slip_bytes (org_id,sha256),
  KEY ix_slip_match (org_id,currency,amount_minor,transfer_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS xero_payment_slip_review (
  org_id BIGINT NOT NULL,
  slip_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  xero_account_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  statement_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  invoice_id BIGINT NULL,
  reviewed_by BIGINT NOT NULL,
  reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id,slip_id),
  KEY ix_slip_statement (org_id,xero_account_id,statement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

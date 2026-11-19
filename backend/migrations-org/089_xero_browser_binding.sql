-- Explicit mapping of Xero's observed UI slug to its API organisation.
-- No guessed mappings and no default seed; configured by an org superadmin.
CREATE TABLE IF NOT EXISTS xero_browser_binding (
  org_id BIGINT NOT NULL,
  ui_org_slug VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  xero_tenant_id VARCHAR(64) NOT NULL,
  updated_by BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy currency rows are exchange-rate snapshots, not denomination records.
-- Explicitly attest the denomination of invoice/lease amounts using that ID.
-- Never rewrite the exchange-rate JSON or infer a currency from its keys.
CREATE TABLE IF NOT EXISTS xero_browser_currency_binding (
  org_id BIGINT NOT NULL,
  currency_id BIGINT NOT NULL,
  currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_by BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id,currency_id),
  UNIQUE KEY uq_browser_currency_code (org_id,currency_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

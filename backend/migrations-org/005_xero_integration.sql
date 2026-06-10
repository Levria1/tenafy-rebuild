-- Per-org migration: Xero integration foundations.
-- Idempotent — each table guarded by CREATE TABLE IF NOT EXISTS and each
-- column guarded by information_schema check.
--
-- Adds:
--   xero_connection                — per-org OAuth tokens + last sync timestamp
--   xero_account_map               — which Xero bank account → which Tenafy account
--   xero_category_rule             — "if description matches X, use category Y"
--   xero_pending_reconciliation    — staging area for proposed sync rows; nothing
--                                    auto-commits to accounting until user approves
--   accounting.xero_transaction_id  — dedup key + reconciliation pointer
--   accounting.reconciliation_status — 'pending' / 'reconciled' / 'unmatched'
--
-- Manual-sync only (no cron). User clicks "Sync Now" on /accounting/reconcile.

-- ── xero_connection ──────────────────────────────────────────────────────────
-- One row per Tenafy org. access_token + refresh_token are stored encrypted
-- (AES-256-GCM) — see services/xeroClient.js for key derivation. xero_tenant_id
-- is Xero's own org identifier (their docs call it "tenantId" — confusing
-- terminology but ours).
CREATE TABLE IF NOT EXISTS xero_connection (
  id                   BIGINT       NOT NULL,
  org_id               BIGINT       NOT NULL,
  xero_tenant_id       VARCHAR(64)  NOT NULL,            -- Xero's UUID for the connected org
  xero_tenant_name     VARCHAR(255) DEFAULT NULL,        -- cached for display
  access_token_enc     TEXT         NOT NULL,            -- encrypted (base64 of iv|tag|ciphertext)
  refresh_token_enc    TEXT         NOT NULL,
  expires_at           TIMESTAMP    NOT NULL,            -- access_token expiry (typically +30 min)
  scopes               TEXT         DEFAULT NULL,
  connected_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at       TIMESTAMP    NULL DEFAULT NULL,
  last_sync_status     VARCHAR(32)  DEFAULT NULL,        -- 'ok' / 'error' / null
  last_sync_message    TEXT         DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_xero_conn_org (org_id)                   -- one Xero connection per Tenafy org
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── xero_account_map ─────────────────────────────────────────────────────────
-- Tells the sync engine: "this Xero bank account corresponds to this Tenafy
-- account_setting." Without this row, transactions from that Xero account get
-- staged with no proposed Tenafy account, forcing the user to set it before
-- they can commit.
CREATE TABLE IF NOT EXISTS xero_account_map (
  id                       BIGINT       NOT NULL,
  org_id                   BIGINT       NOT NULL,
  xero_account_id          VARCHAR(64)  NOT NULL,        -- Xero's UUID for the bank account
  xero_account_code        VARCHAR(32)  DEFAULT NULL,    -- e.g. "090"  (Xero's user-set code)
  xero_account_name        VARCHAR(255) DEFAULT NULL,    -- cached for display
  xero_account_type        VARCHAR(32)  DEFAULT NULL,    -- BANK / CURRENT / etc.
  tenafy_account_setting_id BIGINT      DEFAULT NULL,    -- target Tenafy account; null = unmapped
  created_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_xero_acct_org (org_id, xero_account_id),
  KEY idx_xero_map_tenafy (tenafy_account_setting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── xero_category_rule ───────────────────────────────────────────────────────
-- User-defined rules for auto-categorizing incoming transactions. Applied in
-- priority order (lower = earlier). LLM categorization is the fallback when no
-- rule matches and the amount is above a threshold.
CREATE TABLE IF NOT EXISTS xero_category_rule (
  id                  BIGINT       NOT NULL,
  org_id              BIGINT       NOT NULL,
  description_pattern VARCHAR(255) NOT NULL,             -- substring or simple wildcard (LIKE)
  category_id         BIGINT       NOT NULL,             -- target category_setting.id
  priority            INT          NOT NULL DEFAULT 100,
  enabled             TINYINT      NOT NULL DEFAULT 1,
  hit_count           INT          NOT NULL DEFAULT 0,   -- bumped each time it fires (useful tuning data)
  last_hit_at         TIMESTAMP    NULL DEFAULT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_xero_rule_org_prio (org_id, enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── xero_pending_reconciliation ──────────────────────────────────────────────
-- Staging area. Every Xero transaction the sync pulls lands here first as a
-- proposal. Nothing hits the `accounting` table until the user approves it
-- on /accounting/reconcile. This is the safety net — sync can re-run as
-- often as you like and worst case you get a longer review queue.
--
-- match_kind explains the proposal:
--   'dedup_existing'   — same date+amount+account already in accounting; will
--                         only stamp xero_transaction_id on the existing row
--   'invoice_payment'  — matches an open invoice by amount + payer name; will
--                         create a payment against that invoice
--   'new_entry'        — no match; will create a new accounting entry
--   'ambiguous'        — multiple Tenafy entries matched date+amount; user
--                         must pick one
--   'unmapped_account' — the Xero bank account isn't mapped yet; can't propose
CREATE TABLE IF NOT EXISTS xero_pending_reconciliation (
  id                         BIGINT       NOT NULL,
  org_id                     BIGINT       NOT NULL,
  xero_transaction_id        VARCHAR(64)  NOT NULL,        -- Xero's BankTransactionID
  xero_account_id            VARCHAR(64)  NOT NULL,
  transaction_date           DATE         NOT NULL,
  amount                     DECIMAL(15,2) NOT NULL,       -- signed: negative = outflow
  currency_code              VARCHAR(8)   DEFAULT NULL,
  reference                  VARCHAR(255) DEFAULT NULL,
  description                TEXT         DEFAULT NULL,    -- payer name + line description
  contact_name               VARCHAR(255) DEFAULT NULL,    -- Xero's "Contact" on the transaction
  raw_payload                JSON         DEFAULT NULL,    -- full Xero response for debugging
  -- Proposed action
  match_kind                 VARCHAR(32)  NOT NULL,        -- see comment above
  proposed_account_id        BIGINT       DEFAULT NULL,    -- mapped Tenafy account
  proposed_category_id       BIGINT       DEFAULT NULL,    -- from rules or LLM
  proposed_invoice_id        BIGINT       DEFAULT NULL,    -- if match_kind = invoice_payment
  proposed_tenant_id         BIGINT       DEFAULT NULL,
  existing_accounting_id     BIGINT       DEFAULT NULL,    -- if match_kind = dedup_existing
  ambiguous_candidates       JSON         DEFAULT NULL,    -- array of accounting_ids if match_kind = ambiguous
  confidence                 VARCHAR(16)  DEFAULT 'medium', -- 'high' / 'medium' / 'low'
  rule_id                    BIGINT       DEFAULT NULL,    -- which xero_category_rule fired (null = LLM or none)
  -- Review state
  status                     VARCHAR(16)  NOT NULL DEFAULT 'pending', -- 'pending' / 'approved' / 'skipped'
  resulting_accounting_id    BIGINT       DEFAULT NULL,    -- set on approve, points to the row we created/linked
  reviewed_by_user_id        BIGINT       DEFAULT NULL,
  reviewed_at                TIMESTAMP    NULL DEFAULT NULL,
  created_at                 TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_xero_pending (org_id, xero_transaction_id),  -- one staging row per Xero txn
  KEY idx_xero_pending_org_status (org_id, status),
  KEY idx_xero_pending_date (org_id, transaction_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── accounting.xero_transaction_id ───────────────────────────────────────────
-- Primary dedup key. Once a row in `accounting` is linked to a Xero
-- transaction (either freshly imported or matched-and-linked via date+amount),
-- this column holds Xero's BankTransactionID. Future syncs see it and skip.
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'accounting' AND COLUMN_NAME = 'xero_transaction_id');
SET @s = IF(@c = 0,
  'ALTER TABLE accounting ADD COLUMN xero_transaction_id VARCHAR(64) DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Index for fast dedup lookup on every sync run.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'accounting' AND INDEX_NAME = 'idx_accounting_xero_txn');
SET @s = IF(@c = 0,
  'ALTER TABLE accounting ADD INDEX idx_accounting_xero_txn (xero_transaction_id)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── accounting.reconciliation_status ─────────────────────────────────────────
-- Lets the UI badge rows: 'reconciled' (linked to Xero), 'unmatched' (in Tenafy
-- but not yet in Xero — likely needs Xero entry), null (legacy, pre-Xero). The
-- sync engine sets this when matching/linking.
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'accounting' AND COLUMN_NAME = 'reconciliation_status');
SET @s = IF(@c = 0,
  'ALTER TABLE accounting ADD COLUMN reconciliation_status VARCHAR(16) DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Composite index for the dedup lookup: "is there a Tenafy entry with this
-- date + amount in this account?" — used heavily during sync.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'accounting' AND INDEX_NAME = 'idx_accounting_dedup');
SET @s = IF(@c = 0,
  'ALTER TABLE accounting ADD INDEX idx_accounting_dedup (org_id, account_setting_id, payment_date, amount)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

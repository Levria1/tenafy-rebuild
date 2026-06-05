-- Shared chatbot "rulebook" — a structured, append-only knowledge store that both
-- the internal Tenafy chatbot and the external TaneChat (WhatsApp) bot draw from.
--
-- Per-org table (lives in each org's own database, like bot_settings). The
-- `visibility` column is the PII/permission boundary:
--   internal  -> only the internal Tenafy bot sees it (default, safe)
--   public    -> also shared with TaneChat / prospect-facing channels
--
-- `kind`:
--   rule  -> a behavior rule ("Parking is included in the rent")
--   faq   -> a question/answer the live DB can't answer (title = question, body = answer)

CREATE TABLE IF NOT EXISTS chat_knowledge (
  id          bigint       NOT NULL,
  kind        varchar(16)  NOT NULL DEFAULT 'rule',      -- 'rule' | 'faq'
  title       varchar(255)          DEFAULT NULL,        -- FAQ question / short label
  body        text         NOT NULL,                     -- the rule text / FAQ answer
  tags        json                  DEFAULT NULL,        -- e.g. ["viewing","pricing"]
  visibility  varchar(16)  NOT NULL DEFAULT 'internal',  -- 'public' | 'internal'
  status      tinyint      NOT NULL DEFAULT 1,           -- 1 active, 0 archived
  sort_order  int          NOT NULL DEFAULT 0,
  source      varchar(32)  NOT NULL DEFAULT 'manual',    -- 'manual' | 'seed' | 'promoted'
  source_ref  bigint                DEFAULT NULL,        -- chat_message id it was promoted from
  created_at  timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status_visibility (status, visibility)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: the HK location/region rule. The internal bot currently lacks this
-- (only TaneChat had it). Seeding it public means BOTH bots become aware.
-- Fixed small ids never collide with app-generated snowflake ids; INSERT IGNORE
-- keeps the migration idempotent.
INSERT IGNORE INTO chat_knowledge (id, kind, title, body, visibility, sort_order, source) VALUES
  (1, 'rule', 'Hong Kong location levels',
   'Hong Kong has two location levels: city = region (Hong Kong Island, Kowloon, or New Territories) and district = neighbourhood (e.g. Causeway Bay, Tsim Sha Tsui, Mong Kok). When a prospect names an area, map it to the right level: "Kowloon" -> city; "Causeway Bay" / "TST" / "Mong Kok" -> district. Common shorthands: TST = Tsim Sha Tsui, CWB = Causeway Bay, HK Island = Hong Kong Island.',
   'public', 10, 'seed');

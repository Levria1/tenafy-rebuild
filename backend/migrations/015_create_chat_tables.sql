-- Chat sessions + messages for the MiniMax-powered assistant.
--
-- One `chat_session` row per conversation. Sessions survive across page
-- refreshes (keyed by `channel` + `channel_user_id`) and tie to a contact
-- in the `tenant` table once we learn who the prospect is.

CREATE TABLE IF NOT EXISTS chat_session (
  id                 BIGINT       NOT NULL,
  channel            VARCHAR(20)  NOT NULL,           -- 'web' | 'whatsapp' | 'staff-test'
  channel_user_id    VARCHAR(255) NOT NULL,           -- widget session uuid, WA phone, or staff user id
  contact_id         BIGINT       DEFAULT NULL,       -- FK to tenant.id when known
  viewer_name        VARCHAR(255) DEFAULT NULL,
  viewer_email       VARCHAR(255) DEFAULT NULL,
  viewer_phone       VARCHAR(64)  DEFAULT NULL,
  language           VARCHAR(10)  DEFAULT NULL,       -- detected by LLM, e.g. 'en', 'sw'
  status             TINYINT      NOT NULL DEFAULT 0, -- 0=active, 1=closed
  bot_disabled       BIT(1)       NOT NULL DEFAULT 0, -- staff takeover flag
  message_count      INT          NOT NULL DEFAULT 0,
  booking_count      INT          NOT NULL DEFAULT 0,
  lead_captured      BIT(1)       NOT NULL DEFAULT 0,
  last_message_at    TIMESTAMP    NULL DEFAULT NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_chat_channel_user (channel, channel_user_id),
  KEY idx_chat_contact (contact_id),
  KEY idx_chat_status_last (status, last_message_at),
  KEY idx_chat_channel (channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every message exchanged in a session. OpenAI/MiniMax-compatible shape
-- so we can replay the exact history back to the model on each turn.
CREATE TABLE IF NOT EXISTS chat_message (
  id            BIGINT       NOT NULL,
  session_id    BIGINT       NOT NULL,
  role          VARCHAR(20)  NOT NULL,            -- 'system' | 'user' | 'assistant' | 'tool'
  content       LONGTEXT     DEFAULT NULL,        -- text content (may be null when tool_calls set)
  tool_calls    JSON         DEFAULT NULL,        -- assistant's tool-call array
  tool_call_id  VARCHAR(64)  DEFAULT NULL,        -- ties a role='tool' message to a specific call
  tool_name     VARCHAR(64)  DEFAULT NULL,
  tokens_in     INT          NOT NULL DEFAULT 0,
  tokens_out    INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cm_session (session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

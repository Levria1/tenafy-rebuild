-- Per-org chatbot configuration. Single row per org (id=1 by convention);
-- a row is lazily inserted on first read if missing.
--
-- `capabilities` JSON shape:
--   {
--     "can_search": true,
--     "can_show_details": true,
--     "can_answer_pricing": true,
--     "can_book_viewings": true,
--     "can_capture_leads": true
--   }

CREATE TABLE IF NOT EXISTS bot_settings (
  id                          BIGINT    NOT NULL DEFAULT 1,
  enabled                     BIT(1)    NOT NULL DEFAULT 0,
  capabilities                JSON      DEFAULT NULL,
  system_prompt               TEXT      DEFAULT NULL,
  max_bookings_per_session    INT       NOT NULL DEFAULT 2,
  max_messages_per_session    INT       NOT NULL DEFAULT 50,
  max_messages_per_day        INT       NOT NULL DEFAULT 500,
  settings_locked             BIT(1)    NOT NULL DEFAULT 0,
  created_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

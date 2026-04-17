-- Custom instructions APPENDED to the built-in system prompt. This is what
-- org admins edit to add business-specific rules (e.g. "always search at the
-- unit level", "mention parking only if the user asks") without having to
-- rewrite the whole prompt.
--
-- The legacy `system_prompt` column remains and REPLACES the default when set
-- (advanced override). In practice, use `custom_instructions`.

ALTER TABLE bot_settings
  ADD COLUMN custom_instructions TEXT DEFAULT NULL AFTER system_prompt;

-- Grant the five Chatbot permission codes to the Landlord System Manager role
-- (role_id = 230000000001) so existing system admins get the new menu + pages
-- without any manual step. Super admins (orgType=6) bypass permission checks
-- in the auth middleware, so they always see everything.
--
-- Codes:
--   LANDLORD/CHAT_SESSION_LIST     — see the sessions list + transcripts
--   LANDLORD/CHAT_SESSION_TAKEOVER — flip the staff-takeover switch on a session
--   LANDLORD/CHAT_SETTINGS_VIEW    — read the bot settings
--   LANDLORD/CHAT_SETTINGS_EDIT    — change capabilities, system prompt, rate caps
--   LANDLORD/CHAT_ANALYTICS_VIEW   — phase-2 analytics dashboard (later)

INSERT IGNORE INTO role_permission (role_id, permission_code) VALUES
  (230000000001, 'LANDLORD/CHAT_SESSION_LIST'),
  (230000000001, 'LANDLORD/CHAT_SESSION_TAKEOVER'),
  (230000000001, 'LANDLORD/CHAT_SETTINGS_VIEW'),
  (230000000001, 'LANDLORD/CHAT_SETTINGS_EDIT'),
  (230000000001, 'LANDLORD/CHAT_ANALYTICS_VIEW');

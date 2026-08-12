-- Partner-forward message for inquiries Tenafy cannot house internally.
-- This text is forwarded to partner agencies when the returned vacancy list is
-- empty. It is deliberately NULL by default because it is outward-facing content
-- the operator must author; never seed or derive a default message.
-- Both no_match_reason values trigger this partner-forward path: the difference
-- between "nothing suitable" and "nothing at all" is internal reporting, not a
-- distinction the partner needs to hear.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'partner_forward_message');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN partner_forward_message TEXT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

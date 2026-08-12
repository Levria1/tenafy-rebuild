-- Inquiry availability-window overrides for the shared vacancy engine.
--
-- min_gap_days / lead_days_nr / lead_days_other are consumed by
-- computeVacancies, which serves BOTH the Facebook posting plan and the
-- chatbot's inquiry answers. Tuning one audience was silently retuning the
-- other.
--
-- These three fields are overrides, not copies. NULL means "use the advertising
-- value", so the split is opt-in per field and there is no second source of
-- truth until the operator creates one on purpose.
--
-- They are deliberately nullable with no default: duplicating the numbers up
-- front would guarantee drift, and Facebook and the chatbot disagreeing about
-- the same unit is worse than a shared value neither audience loves.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_min_gap_days');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_min_gap_days SMALLINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_lead_days_nr');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_lead_days_nr SMALLINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'advertising_setting'
     AND COLUMN_NAME = 'inquiry_lead_days_other');
SET @s := IF(@c = 0,
  'ALTER TABLE advertising_setting ADD COLUMN inquiry_lead_days_other SMALLINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

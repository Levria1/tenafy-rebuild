-- Per-org migration: tentative Google Calendar holds for viewing negotiations.
--
-- The hold columns are separate from viewing_booking.gcal_event_id because the
-- hold is tentative and belongs to the negotiation, while the booking event is
-- confirmed and belongs to the booking. They have different lifetimes: a
-- confirmation deletes the tentative hold and creates the confirmed event.
-- Sharing one column would make "which event is this?" ambiguous and risk
-- deleting the confirmed event during hold cleanup.
--
-- gcal_hold_datetime and gcal_hold_calendar_id are stored because the relay can
-- move the proposed time repeatedly, and the assigned staffer can change with
-- it. To patch or delete the right event we need to know where it was written
-- and what time it currently shows. The stored calendar id is especially
-- important because staff_employee_id may already have moved on by cleanup time.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'gcal_hold_event_id');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN gcal_hold_event_id VARCHAR(255) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'gcal_hold_datetime');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN gcal_hold_datetime DATETIME NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_negotiation'
     AND COLUMN_NAME = 'gcal_hold_calendar_id');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_negotiation ADD COLUMN gcal_hold_calendar_id VARCHAR(255) NULL',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

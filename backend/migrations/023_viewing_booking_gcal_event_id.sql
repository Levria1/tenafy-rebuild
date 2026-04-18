-- Migration 023: Add Google Calendar event ID to viewing_booking
-- Allows the backend to update/delete the calendar event on cancellation.

ALTER TABLE viewing_booking
  ADD COLUMN gcal_event_id VARCHAR(255) DEFAULT NULL AFTER ics_uid;

-- Migration 024: Add Google Calendar ID to user
-- Each staff member points to their own Google Calendar. The system pushes
-- confirmed viewings to the calendar owned by the assigned employee, so
-- each person sees only their own bookings (others can cross-subscribe
-- with read access to see each other's schedules).

ALTER TABLE user
  ADD COLUMN google_calendar_id VARCHAR(255) DEFAULT NULL;

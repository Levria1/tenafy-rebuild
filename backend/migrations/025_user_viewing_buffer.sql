-- Migration 025: Per-employee viewing buffer
--
-- When a viewing is booked, the system blocks the same employee from taking
-- another viewing within this buffer (in minutes). Dennis might set 15 (same
-- property, short walk) while CL might set 60 (spread across town).

ALTER TABLE user
  ADD COLUMN viewing_buffer_minutes SMALLINT NOT NULL DEFAULT 30;

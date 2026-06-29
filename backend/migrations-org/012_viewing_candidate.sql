-- 012_viewing_candidate.sql  (PER-ORG)
-- Phase B slice 2 of the prospect-led viewing scheduler.
--
-- A prospect opens their prefilled invite link and proposes UP TO 3 candidate
-- times. We create ONE viewing_booking (status 0 = pending, awaiting the
-- tenant) plus one viewing_candidate row per proposed time. The tenant taps a
-- candidate's confirm_token to lock it in; the others are released.
--
-- Also extends viewing_booking:
--   invite_id      — links back to the viewing_invite the prospect used.
--   awaiting       — 'prospect' | 'tenant' | NULL — who the dashboard is waiting on.
--   superseded_by  — when a request is rescheduled, points at its replacement.
-- and relaxes link_id to NULL (invite-sourced bookings have no viewing_link row).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + information_schema-guarded ALTERs.

CREATE TABLE IF NOT EXISTS viewing_candidate (
  id                BIGINT       NOT NULL PRIMARY KEY,
  booking_id        BIGINT       NOT NULL,
  proposed_datetime DATETIME     NOT NULL,
  duration_minutes  INT          NOT NULL DEFAULT 30,
  confirm_token     VARCHAR(64)  NOT NULL,
  status            TINYINT      NOT NULL DEFAULT 1,  -- 1=tentative, 2=picked, 0=released
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_viewing_candidate_token (confirm_token),
  KEY idx_viewing_candidate_booking (booking_id),
  KEY idx_viewing_candidate_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- viewing_booking.invite_id
SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_booking' AND COLUMN_NAME = 'invite_id');
SET @ddl1 := IF(@c1 = 0,
  'ALTER TABLE viewing_booking ADD COLUMN invite_id BIGINT NULL DEFAULT NULL AFTER inquiry_id',
  'SELECT 1');
PREPARE s1 FROM @ddl1; EXECUTE s1; DEALLOCATE PREPARE s1;

-- viewing_booking.awaiting
SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_booking' AND COLUMN_NAME = 'awaiting');
SET @ddl2 := IF(@c2 = 0,
  'ALTER TABLE viewing_booking ADD COLUMN awaiting VARCHAR(16) NULL DEFAULT NULL AFTER status',
  'SELECT 1');
PREPARE s2 FROM @ddl2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- viewing_booking.superseded_by
SET @c3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_booking' AND COLUMN_NAME = 'superseded_by');
SET @ddl3 := IF(@c3 = 0,
  'ALTER TABLE viewing_booking ADD COLUMN superseded_by BIGINT NULL DEFAULT NULL AFTER awaiting',
  'SELECT 1');
PREPARE s3 FROM @ddl3; EXECUTE s3; DEALLOCATE PREPARE s3;

-- Relax link_id to NULL (invite-sourced bookings have no viewing_link).
SET @c4 := (SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_booking' AND COLUMN_NAME = 'link_id');
SET @ddl4 := IF(@c4 = 'NO',
  'ALTER TABLE viewing_booking MODIFY COLUMN link_id BIGINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE s4 FROM @ddl4; EXECUTE s4; DEALLOCATE PREPARE s4;

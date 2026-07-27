-- 023_viewing_staff_roster.sql  (PER-ORG)
-- Viewing Relay Scheduler — property × weekday responsible-staff roster.
--
-- When a prospect proposes a day, the system resolves the staffer on duty for
-- that property on that weekday and checks THEIR Google calendar. weekday uses
-- JavaScript Date.getDay(): 0=Sunday .. 6=Saturday.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS viewing_staff_roster (
  id           BIGINT     NOT NULL PRIMARY KEY,
  property_id  BIGINT     NOT NULL,
  weekday      TINYINT    NOT NULL,              -- 0=Sun .. 6=Sat
  employee_id  BIGINT     NOT NULL,
  active       TINYINT    NOT NULL DEFAULT 1,
  created_at   TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_vsr_property_weekday (property_id, weekday),
  KEY idx_vsr_property (property_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

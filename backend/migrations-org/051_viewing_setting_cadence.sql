-- Per-org migration: viewing relay v2 nudge and opt-out cadence settings.
--
-- auto_send_nudges defaults to 0 (OFF). Today relay_mode='manual' guarantees no
-- message reaches a customer or tenant without staff approval. The new
-- send_mode:'auto' protocol deliberately punches through that guarantee for
-- nudges. Defaulting it ON would change the behaviour of a live org during a
-- deploy, silently. It must be an explicit opt-in.
--
-- Cadence: nudge at 1h, nudge again at 6h, escalate to NEEDS_STAFF at 24h.
--
-- The design doc asked for the second nudge at 24h with a 48h timeout, but those
-- two clocks collide with the deployed stale reaper, which escalates at 24h: the
-- escalation fires first, moves the row to NEEDS_STAFF, and nudging stops — so the
-- second nudge could never happen and customer_nudge_cap=2 would be dead config.
--
-- Resolved (operator decision, 2026-08-12) by moving the SECOND NUDGE EARLIER
-- rather than pushing escalation later: both nudges now genuinely fire, and a dead
-- lead still reaches a human within a day, which is the promise the live 24h
-- escalation already makes. This is also strictly more nudging than production does
-- today (one reminder at VIEWING_REMINDER_HOURS=4).

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'customer_nudge_1_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN customer_nudge_1_hours SMALLINT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'customer_nudge_2_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN customer_nudge_2_hours SMALLINT NOT NULL DEFAULT 6',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'customer_nudge_cap');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN customer_nudge_cap TINYINT NOT NULL DEFAULT 2',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'customer_timeout_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN customer_timeout_hours SMALLINT NOT NULL DEFAULT 24',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'tenant_opt_out_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN tenant_opt_out_hours SMALLINT NOT NULL DEFAULT 4',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'tenant_explicit_timeout_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN tenant_explicit_timeout_hours SMALLINT NOT NULL DEFAULT 24',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'tenant_nudge_cap');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN tenant_nudge_cap TINYINT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'auto_send_nudges');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN auto_send_nudges TINYINT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viewing_setting'
     AND COLUMN_NAME = 'respect_quiet_hours');
SET @s := IF(@c = 0,
  'ALTER TABLE viewing_setting ADD COLUMN respect_quiet_hours TINYINT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

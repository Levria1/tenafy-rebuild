-- 040 — intentionally a no-op.
--
-- This file used to backfill `leasing.check_in_meter` on every existing lease
-- that was missing it. We decided NOT to touch historical data.
--
-- Going forward, new leases auto-fill `check_in_meter` from the previous
-- tenant's last meter reading via:
--   - Backend: POST /api/leasing back-fill in backend/src/routes/leasing.js
--   - Frontend: prefill on the create-lease form
-- Both call `findLastMeterReadingForUnit` in backend/src/utils/meterReadingLookup.js.
--
-- Existing leases keep whatever check_in_meter value (or NULL) they had.
-- If you want to backfill one specific lease later, set its check_in_meter
-- manually in the UI or via a targeted UPDATE.
--
-- The migration runner still applies this file so the version number is
-- recorded in `schema_migrations` and future migrations stay in sequence.

SELECT 1;

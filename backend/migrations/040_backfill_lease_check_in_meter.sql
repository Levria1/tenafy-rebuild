-- One-time back-fill: for any lease where check_in_meter IS NULL but a meter
-- reading was logged on the same unit BEFORE the lease's start_date, use that
-- reading's value as the check-in meter.
--
-- Catches the historical case where a previous tenant was checked out BEFORE
-- the next tenant's lease was created — at checkout time there was no "next
-- lease" to write to, so the carry-over silently did nothing.
--
-- After this migration AND the code change in POST /api/leasing, future
-- leases created after a checkout will auto-fill correctly. This SQL is
-- purely for cleaning up the existing data backlog.
--
-- Idempotent: re-running does nothing since matched leases will already have
-- check_in_meter set.

UPDATE leasing l
JOIN (
  SELECT
    l2.id AS lease_id,
    (
      SELECT mr.reading_value
      FROM utility_meter_reading mr
      JOIN utility_meter m ON mr.meter_id = m.id
      WHERE m.unit_id = l2.unit_id
        AND mr.reading_date < l2.start_date
      ORDER BY mr.reading_date DESC, mr.created_at DESC
      LIMIT 1
    ) AS last_value
  FROM leasing l2
  WHERE l2.deleted_at IS NULL
    AND l2.check_in_meter IS NULL
) prior ON prior.lease_id = l.id
SET l.check_in_meter = prior.last_value,
    l.check_in_meter_updated_at = NOW()
WHERE prior.last_value IS NOT NULL
  AND l.check_in_meter IS NULL;

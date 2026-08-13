-- Repair legacy 2021 accounting imports where the old system wrote the
-- property-owner tag to accounting_line only. Without this, the tag is
-- invisible in the UI because list and detail queries read accounting.tag_id,
-- and the next Save can destroy it by rebuilding the line from the header.

UPDATE accounting a
JOIN (
  SELECT accounting_id, MIN(tag_id) AS tag_id
  FROM accounting_line
  WHERE deleted_at IS NULL AND tag_id IS NOT NULL
  GROUP BY accounting_id
  -- Only backfill when all tagged lines agree on one tag. If lines carry
  -- different tags, there is no single correct header value to guess.
  HAVING COUNT(DISTINCT tag_id) = 1
) t ON t.accounting_id = a.id
SET a.tag_id = t.tag_id,
    -- Preserve the real edit timestamp; this is a data repair, not a user edit.
    a.updated_at = a.updated_at
-- Never overwrite an operator-chosen tag. This also makes the migration
-- idempotent: after it runs, no repaired row still matches this WHERE clause,
-- so no information_schema PREPARE/EXECUTE guard is needed.
WHERE a.tag_id IS NULL AND a.deleted_at IS NULL;

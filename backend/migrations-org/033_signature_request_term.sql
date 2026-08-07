-- Per-org migration: turn signature_request into a per-period document ledger.
--
-- A tenancy that is extended by editing leasing.end_date needs a separate
-- signed document per period. signature_request already allows many rows per
-- lease (lease_id is not unique) — it just never recorded WHICH period each
-- document covers, nor whether it was signed electronically or on paper.
--
-- No changes to the leasing table: extending stays an edit to the lease row.

-- ── signature_request.term_start ─────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'term_start');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD COLUMN term_start DATE NULL DEFAULT NULL AFTER template_version',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── signature_request.term_end ───────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'term_end');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD COLUMN term_end DATE NULL DEFAULT NULL AFTER term_start',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── signature_request.term_stamp_end ─────────────────────────────────────────
-- The stamped Term of Tenancy for THIS period. NULL = the period's own end.
-- leasing.stamp_end_date is one value per lease and is never written back, so
-- each period keeps its own stamping record.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'term_stamp_end');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD COLUMN term_stamp_end DATE NULL DEFAULT NULL AFTER term_end',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── signature_request.signature_method ───────────────────────────────────────
-- 'esign' = signed through the token flow; 'paper' = a scan recorded by staff.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'signature_method');
SET @s := IF(@c = 0,
  "ALTER TABLE signature_request ADD COLUMN signature_method VARCHAR(16) NOT NULL DEFAULT 'esign' AFTER status",
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── index for the gap query ──────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND INDEX_NAME = 'idx_sr_lease_term');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD INDEX idx_sr_lease_term (lease_id, status, term_end)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- NO BACKFILL, deliberately. Existing rows keep NULL periods and display as
-- "period not recorded". Backfilling from the lease's current dates would
-- assert that an old document covers a term it may never have covered — a
-- lease already extended by editing would get a wrong, official-looking period.

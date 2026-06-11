-- Add per-signer initials image to signature_party.
--
-- Used for the "initial on every page" feature: each signer can provide an
-- initials mark (separate from their full signature) on the /sign page. The
-- stamper draws this initials PNG in a fixed corner of every content page.
--
-- Idempotent: guarded so re-running on an org that already has the column is a
-- no-op. Safe to apply to every org DB via `npm run migrate:orgs`.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'signature_party'
    AND column_name = 'initials_png'
);

SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE signature_party ADD COLUMN initials_png LONGTEXT DEFAULT NULL AFTER signature_png',
  'SELECT 1');

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

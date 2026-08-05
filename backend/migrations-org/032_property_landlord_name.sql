-- 032_property_landlord_name.sql  (PER-ORG)
-- Landlord / legal entity name at the PROPERTY level.
--
-- WHY: invoice + receipt PDFs print their company header from
-- `unit.account_name || org.company_name`, but `org_setting` (where
-- org.company_name came from) does not exist in any org DB — the query is
-- `.catch(() => [[]])`-wrapped, so it silently resolves to ''. Result: any unit
-- with no account_name produced a document with NO company name at all (on
-- receipts the title even fell back to the literal word "RECEIPT"). On the live
-- org that was 34 of 112 currently-leased units.
--
-- WHY PROPERTY-LEVEL, not org-level: an org can hold several landlord entities
-- (this org has four — ACJ Ventures, Naos Holdings, Parcelle, Tane Residence —
-- one contract template each via the per-property allowlist). Entity identity
-- belongs to the property; the unit keeps overriding it where set.
--
-- Idempotent: information_schema-guarded, and the backfill only fills NULLs.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'property' AND COLUMN_NAME = 'landlord_name');
SET @ddl := IF(@c = 0,
  'ALTER TABLE property ADD COLUMN landlord_name VARCHAR(255) NULL DEFAULT NULL AFTER display_name',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill from the property's own units. Safe because every property is
-- entity-consistent (verified on the live org: no property mixes two entities).
-- TRIM matters — some existing values carry a leading space (" NAOS Holdings
-- Limited"), which would otherwise read as a different entity.
--
-- GUARDED on unit.account_name existing: orgs created from
-- src/migrations/org_schema_template.sql have no such column (it only exists in
-- DBs imported from the legacy Java dump), so an unguarded UPDATE fails there
-- with "Unknown column 'u.account_name'". Those orgs have no source data to
-- backfill anyway — the column is simply left NULL for manual entry.
SET @has_src := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unit' AND COLUMN_NAME = 'account_name');
SET @bf := IF(@has_src = 1, '
UPDATE property p
   SET p.landlord_name = (
     SELECT NULLIF(TRIM(u.account_name), \'\')
       FROM unit u
      WHERE u.property_id = p.id
        AND TRIM(COALESCE(u.account_name, \'\')) <> \'\'
      ORDER BY u.id ASC
      LIMIT 1
   )
 WHERE p.landlord_name IS NULL OR p.landlord_name = \'\'',
  'SELECT 1');
PREPARE s2 FROM @bf; EXECUTE s2; DEALLOCATE PREPARE s2;

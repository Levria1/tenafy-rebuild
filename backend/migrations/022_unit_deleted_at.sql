-- Add missing `deleted_at` column to the `unit` table. The delete handler in
-- routes/property.js writes to this column, so absent it, unit deletes have
-- been failing on this DB. The org schema template already has it; this
-- migration is for pre-existing DBs that pre-date its introduction (e.g.
-- `tena_prod` restored from the Java Tenafy dump).
--
-- If the column already exists, this ALTER will error with "Duplicate column".
-- That's safe to ignore — it means the column is already present.

ALTER TABLE unit
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL;

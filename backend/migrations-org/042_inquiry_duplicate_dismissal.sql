-- Per-org migration: remember duplicate suggestions staff dismissed.
--
-- pair_key is order-independent because dismissing A/B must also suppress B/A.
-- A two-column unique key on (inquiry_id, other_inquiry_id) would let the
-- mirrored pair through and show staff the same false suggestion again.

SET @t := (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inquiry_duplicate_dismissal');
SET @ddl := IF(@t = 0, 'CREATE TABLE inquiry_duplicate_dismissal (
  id BIGINT NOT NULL PRIMARY KEY,
  org_id BIGINT NOT NULL,
  pair_key VARCHAR(64) NOT NULL,
  inquiry_id BIGINT NOT NULL,
  other_inquiry_id BIGINT NOT NULL,
  dismissed_by_user_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dismissal (org_id, pair_key),
  KEY idx_inquiry (org_id, inquiry_id)
)', 'SELECT 1');
PREPARE st FROM @ddl; EXECUTE st; DEALLOCATE PREPARE st;

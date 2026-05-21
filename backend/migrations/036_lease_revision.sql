-- Scheduled mid-lease changes for rent / credits / utility credit / deposit.
-- Each row is a "revision" that takes effect on `effective_from` and overrides
-- the corresponding columns on `leasing` for any invoice whose due_on >= that
-- date (until a later revision supersedes it). NULL values inherit from the
-- previous revision (or from `leasing` itself if no earlier revision).
--
-- Backward compatible: leases with zero rows in this table behave exactly as
-- before — the scheduler falls back to `leasing.amount`, `leasing.credits`,
-- `leasing.utility_credit`, `leasing.deposit`.

CREATE TABLE IF NOT EXISTS `lease_revision` (
  `id` bigint NOT NULL,
  `lease_id` bigint NOT NULL,
  `effective_from` date NOT NULL,
  `price` decimal(10,2) DEFAULT NULL,
  `credits` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `utility_credit` decimal(10,2) DEFAULT NULL,
  `deposit` decimal(10,2) DEFAULT NULL,
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_by` bigint DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lease_effective` (`lease_id`, `effective_from`),
  KEY `idx_effective_from` (`effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

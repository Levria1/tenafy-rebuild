-- Migration 004: Add payment_instructions column to property table
-- Stores free-text payment instructions shown to tenants (e.g. bank account, payment methods)

ALTER TABLE `property`
  ADD COLUMN `payment_instructions` TEXT DEFAULT NULL AFTER `notes`;

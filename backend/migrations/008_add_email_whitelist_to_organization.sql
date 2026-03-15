-- Add email whitelist columns to organization table for safe email testing
ALTER TABLE organization
  ADD COLUMN email_whitelist_enabled BIT(1) DEFAULT b'1' AFTER email_count,
  ADD COLUMN email_whitelist TEXT DEFAULT NULL AFTER email_whitelist_enabled;

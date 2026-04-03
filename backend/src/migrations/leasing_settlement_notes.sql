-- Add settlement_notes column to leasing table for checkout settlement notes
-- MySQL 8.0 doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN
-- Check manually: SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_NAME='leasing' AND COLUMN_NAME='settlement_notes';
ALTER TABLE leasing ADD COLUMN settlement_notes TEXT DEFAULT NULL;

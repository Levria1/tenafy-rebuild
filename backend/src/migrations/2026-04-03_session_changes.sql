-- 2026-04-03 Session Changes
-- Run on droplet: mysql -u root -p000000 tena_prodv2 < this_file.sql

-- 1. Widen property address columns (country was char(2), city/state were varchar(20))
ALTER TABLE property MODIFY COLUMN country varchar(100) DEFAULT NULL;
ALTER TABLE property MODIFY COLUMN city varchar(100) DEFAULT NULL;
ALTER TABLE property MODIFY COLUMN state varchar(100) DEFAULT NULL;

-- 2. Add settlement notes column to leasing table (for Payments tab notes)
ALTER TABLE leasing ADD COLUMN settlement_notes TEXT DEFAULT NULL;

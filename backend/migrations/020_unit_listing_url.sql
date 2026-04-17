-- Optional per-unit listing URL (e.g. taneresidence.com/apartments/sun-gardens-3b).
-- When set, the chatbot prefers this over the property-level URL when recommending
-- a specific unit. Falls back to property.listing_url when null.

ALTER TABLE unit
  ADD COLUMN listing_url VARCHAR(500) DEFAULT NULL AFTER internal_note;

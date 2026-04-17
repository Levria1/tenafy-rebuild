-- External listing URL per property (e.g. the page on taneresidence.com).
-- When present, the chatbot links prospects out to this page instead of trying
-- to render photos in chat.

ALTER TABLE property
  ADD COLUMN listing_url VARCHAR(500) DEFAULT NULL AFTER notes;

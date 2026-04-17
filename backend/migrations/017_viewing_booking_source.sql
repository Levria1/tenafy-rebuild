-- Tag every viewing booking with where it came from so staff can filter
-- bot-generated submissions vs organic web vs manual entries.
-- Values: 'web' (default, public form) | 'bot' (chatbot) | 'whatsapp' | 'manual'

ALTER TABLE viewing_booking
  ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'web' AFTER status,
  ADD KEY idx_vb_source (source);

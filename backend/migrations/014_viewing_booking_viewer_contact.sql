-- Link a viewing booking back to the prospect's row in the `tenant` contacts
-- table. On booking submission we upsert a contact (category=3 = prospect)
-- scoped by email within the org, then store its id here for traceability.

ALTER TABLE viewing_booking
  ADD COLUMN viewer_contact_id BIGINT DEFAULT NULL AFTER tenant_id,
  ADD KEY idx_vb_viewer_contact (viewer_contact_id);

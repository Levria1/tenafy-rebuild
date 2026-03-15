-- Add template_id and lease_id to email_log for traceability
ALTER TABLE email_log
  ADD COLUMN template_id BIGINT DEFAULT NULL AFTER type,
  ADD COLUMN lease_id BIGINT DEFAULT NULL AFTER template_id;

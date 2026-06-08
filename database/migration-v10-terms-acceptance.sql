-- v10: Record Terms & Privacy acceptance at signup and partner application

USE ticket_malawi;

ALTER TABLE users
  ADD COLUMN terms_accepted_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN terms_version VARCHAR(32) NULL DEFAULT NULL;

ALTER TABLE partner_applications
  ADD COLUMN terms_accepted_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN terms_version VARCHAR(32) NULL DEFAULT NULL;

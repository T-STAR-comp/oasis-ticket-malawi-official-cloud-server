-- Organizer payouts + settlement (PayChangu T+1)
USE ticket_malawi;

ALTER TABLE organizer_profiles
  ADD COLUMN payout_bank_uuid VARCHAR(36) NULL AFTER bio,
  ADD COLUMN payout_bank_name VARCHAR(128) NULL AFTER payout_bank_uuid,
  ADD COLUMN payout_account_name VARCHAR(255) NULL AFTER payout_bank_name,
  ADD COLUMN payout_account_number VARCHAR(64) NULL AFTER payout_account_name;

CREATE TABLE IF NOT EXISTS organizer_payouts (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id         CHAR(36)     NOT NULL,
  amount_mwk           INT UNSIGNED NOT NULL,
  status               ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  paychangu_charge_id  VARCHAR(64)  NOT NULL UNIQUE,
  payout_method        VARCHAR(32)  NOT NULL DEFAULT 'bank_transfer',
  bank_uuid            VARCHAR(36)  NOT NULL,
  bank_account_name    VARCHAR(255) NOT NULL,
  bank_account_number  VARCHAR(64)  NOT NULL,
  provider_status      VARCHAR(32)  NULL,
  failure_reason       TEXT         NULL,
  requested_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at         TIMESTAMP    NULL,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_payouts_organizer_status (organizer_id, status),
  CONSTRAINT fk_payouts_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

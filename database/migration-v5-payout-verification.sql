-- Payout email verification before PayChangu transfer
USE ticket_malawi;

CREATE TABLE IF NOT EXISTS payout_verifications (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id        CHAR(36)     NOT NULL,
  amount_mwk            INT UNSIGNED NOT NULL,
  bank_uuid             VARCHAR(36)  NOT NULL,
  bank_name             VARCHAR(128) NOT NULL,
  account_name          VARCHAR(255) NOT NULL,
  account_number        VARCHAR(64)  NOT NULL,
  branch                VARCHAR(128) NULL,
  verification_email    VARCHAR(255) NOT NULL,
  verification_code     VARCHAR(6)   NOT NULL,
  status                ENUM('pending', 'verified', 'expired', 'failed', 'completed') NOT NULL DEFAULT 'pending',
  failure_reason        TEXT         NULL,
  payout_id             CHAR(36)     NULL,
  attempt_count         INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at            TIMESTAMP    NOT NULL,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_payout_verify_organizer (organizer_id, status),
  INDEX idx_payout_verify_expires (status, expires_at),
  CONSTRAINT fk_payout_verify_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

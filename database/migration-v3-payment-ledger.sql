-- Payment ledger + ticket QR tokens (PayChangu flow)
USE ticket_malawi;

ALTER TABLE user_tickets
  ADD COLUMN qr_token VARCHAR(64) NULL AFTER reference;

UPDATE user_tickets SET qr_token = REPLACE(UUID(), '-', '') WHERE qr_token IS NULL;

ALTER TABLE user_tickets
  MODIFY qr_token VARCHAR(64) NOT NULL,
  ADD UNIQUE KEY uq_user_tickets_qr (qr_token);

CREATE TABLE IF NOT EXISTS payment_ledger (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  user_id              CHAR(36)     NOT NULL,
  order_id             CHAR(36)     NOT NULL UNIQUE,
  status               ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  paychangu_charge_id  VARCHAR(64)  NOT NULL UNIQUE,
  paychangu_trans_id   VARCHAR(64)  NULL,
  paychangu_ref_id     VARCHAR(64)  NULL,
  amount_mwk           INT UNSIGNED NOT NULL,
  payment_method       ENUM('airtel', 'tnm', 'card') NOT NULL,
  payment_phone        VARCHAR(32)  NULL,
  account_name         VARCHAR(255) NOT NULL,
  account_email        VARCHAR(255) NOT NULL,
  account_phone        VARCHAR(32)  NOT NULL,
  checkout_meta        JSON         NOT NULL,
  provider_status      VARCHAR(32)  NULL,
  failure_reason       TEXT         NULL,
  expires_at           TIMESTAMP    NOT NULL,
  completed_at         TIMESTAMP    NULL,
  last_polled_at       TIMESTAMP    NULL,
  poll_count           INT UNSIGNED NOT NULL DEFAULT 0,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ledger_user_status (user_id, status),
  INDEX idx_ledger_pending_expires (status, expires_at),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

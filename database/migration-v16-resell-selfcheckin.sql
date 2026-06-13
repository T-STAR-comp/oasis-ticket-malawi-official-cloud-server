-- Resell marketplace, saved payment phone, self check-in

ALTER TABLE payment_methods
  ADD COLUMN phone_number VARCHAR(32) NULL DEFAULT NULL AFTER details_masked;

CREATE TABLE IF NOT EXISTS resell_listings (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  user_ticket_id  CHAR(36)     NOT NULL,
  seller_user_id  CHAR(36)     NOT NULL,
  listing_id      VARCHAR(64)  NOT NULL,
  price_mwk       INT UNSIGNED NOT NULL,
  status          ENUM('active', 'sold', 'cancelled') NOT NULL DEFAULT 'active',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sold_at         TIMESTAMP    NULL DEFAULT NULL,
  cancelled_at    TIMESTAMP    NULL DEFAULT NULL,
  UNIQUE KEY uq_resell_ticket (user_ticket_id),
  INDEX idx_resell_active (status, created_at),
  INDEX idx_resell_seller (seller_user_id, status),
  CONSTRAINT fk_resell_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_resell_seller FOREIGN KEY (seller_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_resell_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS resell_sales (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  resell_listing_id  CHAR(36)     NOT NULL,
  order_id           CHAR(36)     NOT NULL,
  buyer_user_id      CHAR(36)     NOT NULL,
  seller_user_id     CHAR(36)     NOT NULL,
  user_ticket_id     CHAR(36)     NOT NULL,
  sale_price_mwk     INT UNSIGNED NOT NULL,
  seller_net_mwk     INT UNSIGNED NOT NULL,
  settlement_status  ENUM('pending_settlement', 'settled', 'cancelled') NOT NULL DEFAULT 'pending_settlement',
  withdrawable_at    TIMESTAMP    NULL DEFAULT NULL,
  settled_at         TIMESTAMP    NULL DEFAULT NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_resell_sale_listing (resell_listing_id),
  INDEX idx_resell_sales_seller (seller_user_id, settlement_status),
  CONSTRAINT fk_rs_listing FOREIGN KEY (resell_listing_id) REFERENCES resell_listings(id),
  CONSTRAINT fk_rs_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_rs_buyer FOREIGN KEY (buyer_user_id) REFERENCES users(id),
  CONSTRAINT fk_rs_seller FOREIGN KEY (seller_user_id) REFERENCES users(id),
  CONSTRAINT fk_rs_ut FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reseller_payouts (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  user_id              CHAR(36)     NOT NULL,
  amount_mwk           INT UNSIGNED NOT NULL,
  fee_mwk              INT UNSIGNED NOT NULL DEFAULT 0,
  net_amount_mwk       INT UNSIGNED NOT NULL,
  status               ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  paychangu_charge_id  VARCHAR(64)  NOT NULL UNIQUE,
  bank_uuid            VARCHAR(36)  NOT NULL,
  bank_account_name    VARCHAR(255) NOT NULL,
  bank_account_number  VARCHAR(64)  NOT NULL,
  provider_status      VARCHAR(32)  NULL,
  failure_reason       TEXT         NULL,
  requested_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at         TIMESTAMP    NULL,
  INDEX idx_reseller_payouts_user (user_id, status),
  CONSTRAINT fk_reseller_payouts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reseller_payout_destinations (
  user_id              CHAR(36)     NOT NULL PRIMARY KEY,
  bank_uuid            VARCHAR(36)  NOT NULL,
  bank_name            VARCHAR(128) NOT NULL,
  account_name         VARCHAR(255) NOT NULL,
  account_number       VARCHAR(64)  NOT NULL,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rpd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reseller_payout_verifications (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  user_id             CHAR(36)     NOT NULL,
  amount_mwk          INT UNSIGNED NOT NULL,
  fee_mwk             INT UNSIGNED NOT NULL DEFAULT 0,
  bank_uuid           VARCHAR(36)  NOT NULL,
  bank_name           VARCHAR(128) NOT NULL,
  account_name        VARCHAR(255) NOT NULL,
  account_number      VARCHAR(64)  NOT NULL,
  branch              VARCHAR(128) NULL,
  verification_email  VARCHAR(255) NOT NULL,
  verification_code   VARCHAR(6)   NOT NULL,
  status              ENUM('pending', 'verified', 'expired', 'failed', 'completed') NOT NULL DEFAULT 'pending',
  failure_reason      TEXT         NULL,
  payout_id           CHAR(36)     NULL,
  attempt_count       INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at          TIMESTAMP    NOT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rsv_user (user_id, status),
  CONSTRAINT fk_rsv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS self_checkin_sessions (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  listing_id           VARCHAR(64)  NOT NULL,
  activated_by_user_id CHAR(36)     NOT NULL,
  gate_token           VARCHAR(64)  NOT NULL,
  status               ENUM('active', 'ended') NOT NULL DEFAULT 'active',
  started_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at             TIMESTAMP    NULL DEFAULT NULL,
  UNIQUE KEY uq_gate_token (gate_token),
  INDEX idx_sci_listing (listing_id, status),
  CONSTRAINT fk_sci_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_sci_user FOREIGN KEY (activated_by_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS self_checkin_events (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  session_id       CHAR(36)     NOT NULL,
  listing_id       VARCHAR(64)  NOT NULL,
  user_ticket_id   CHAR(36)     NOT NULL,
  holder_user_id   CHAR(36)     NOT NULL,
  holder_name      VARCHAR(255) NULL,
  ticket_reference VARCHAR(32)  NOT NULL,
  result           ENUM('accepted', 'rejected') NOT NULL,
  reject_reason    VARCHAR(255) NULL,
  verified_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sce_session (session_id, verified_at),
  INDEX idx_sce_listing (listing_id, verified_at),
  CONSTRAINT fk_sce_session FOREIGN KEY (session_id) REFERENCES self_checkin_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE ticket_verifications
  MODIFY COLUMN method ENUM('reference', 'qr_scan', 'self_checkin') NOT NULL;

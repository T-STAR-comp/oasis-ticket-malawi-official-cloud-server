-- E-Sports tournaments (admin-managed competitive events)
USE ticket_malawi;

CREATE TABLE IF NOT EXISTS esports_events (
  id                      CHAR(36)     NOT NULL PRIMARY KEY,
  name                    VARCHAR(255) NOT NULL,
  description             TEXT         NOT NULL,
  event_date              DATE         NOT NULL,
  event_time              VARCHAR(32)  NOT NULL,
  entry_price_mwk         INT UNSIGNED NOT NULL DEFAULT 0,
  image_url               VARCHAR(512) NULL,
  game_name               VARCHAR(128) NOT NULL,
  match_duration_minutes  INT UNSIGNED NOT NULL,
  grand_prize_mwk         INT UNSIGNED NOT NULL,
  status                  ENUM('draft', 'published', 'completed', 'archived') NOT NULL DEFAULT 'draft',
  match_link              VARCHAR(512) NULL,
  match_password          VARCHAR(128) NULL,
  winner_user_id          CHAR(36)     NULL,
  winner_registration_id  CHAR(36)     NULL,
  winner_game_username    VARCHAR(128) NULL,
  winner_proof_image_url  VARCHAR(512) NULL,
  settled_at              TIMESTAMP    NULL,
  created_by_admin_id     CHAR(36)     NOT NULL,
  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_esports_events_status (status, event_date),
  INDEX idx_esports_events_settled (status, settled_at),
  CONSTRAINT fk_esports_events_winner FOREIGN KEY (winner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_esports_events_admin FOREIGN KEY (created_by_admin_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS esports_registrations (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  event_id            CHAR(36)     NOT NULL,
  user_id             CHAR(36)     NOT NULL,
  game_username       VARCHAR(128) NOT NULL,
  amount_paid_mwk     INT UNSIGNED NOT NULL DEFAULT 0,
  payment_status      ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  paychangu_charge_id VARCHAR(64)  NULL,
  payment_method      ENUM('airtel', 'tnm', 'card', 'free') NULL,
  payment_phone       VARCHAR(32)  NULL,
  failure_reason      TEXT         NULL,
  registered_at       TIMESTAMP    NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_esports_reg_event_user (event_id, user_id),
  INDEX idx_esports_reg_user (user_id, payment_status),
  INDEX idx_esports_reg_pending (payment_status, created_at),
  CONSTRAINT fk_esports_reg_event FOREIGN KEY (event_id) REFERENCES esports_events(id) ON DELETE CASCADE,
  CONSTRAINT fk_esports_reg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS esports_wallets (
  user_id     CHAR(36)     NOT NULL PRIMARY KEY,
  balance_mwk INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_esports_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS esports_payout_destinations (
  user_id        CHAR(36)     NOT NULL PRIMARY KEY,
  bank_uuid      VARCHAR(36)  NOT NULL,
  bank_name      VARCHAR(128) NOT NULL,
  account_name   VARCHAR(255) NOT NULL,
  account_number VARCHAR(64)  NOT NULL,
  branch         VARCHAR(128) NULL,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_esports_payout_dest_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS esports_payouts (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  user_id             CHAR(36)     NOT NULL,
  amount_mwk          INT UNSIGNED NOT NULL,
  fee_mwk             INT UNSIGNED NOT NULL DEFAULT 0,
  status              ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  paychangu_charge_id VARCHAR(64)  NOT NULL UNIQUE,
  bank_uuid           VARCHAR(36)  NOT NULL,
  bank_account_name   VARCHAR(255) NOT NULL,
  bank_account_number VARCHAR(64)  NOT NULL,
  provider_status     VARCHAR(32)  NULL,
  failure_reason      TEXT         NULL,
  requested_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at        TIMESTAMP    NULL,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_esports_payouts_user (user_id, status),
  CONSTRAINT fk_esports_payouts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS esports_payout_verifications (
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
  INDEX idx_esports_payout_verify_user (user_id, status),
  CONSTRAINT fk_esports_payout_verify_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

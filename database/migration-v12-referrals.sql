-- Listing referrals: organizer-created codes, referrer commissions, buyer discounts.

CREATE TABLE IF NOT EXISTS listing_referrals (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id       CHAR(36)     NOT NULL,
  listing_id         VARCHAR(64)  NOT NULL,
  code               VARCHAR(64)  NOT NULL,
  name               VARCHAR(128) NOT NULL,
  type               ENUM('split_both', 'split_referrer', 'discount_only') NOT NULL,
  cut_percent        TINYINT UNSIGNED NOT NULL,
  referrer_user_id   CHAR(36)     NULL,
  status             ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referral_listing_code (listing_id, code),
  INDEX idx_referrals_organizer (organizer_id, status),
  INDEX idx_referrals_listing_active (listing_id, status),
  INDEX idx_referrals_referrer (referrer_user_id),
  CONSTRAINT fk_referrals_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_referrals_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_referrals_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS referrer_profiles (
  user_id               CHAR(36)     NOT NULL PRIMARY KEY,
  payout_bank_uuid      VARCHAR(36)  NULL,
  payout_bank_name      VARCHAR(128) NULL,
  payout_account_name   VARCHAR(255) NULL,
  payout_account_number VARCHAR(64)  NULL,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_referrer_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS referral_earnings (
  id                    CHAR(36)     NOT NULL PRIMARY KEY,
  referral_id           CHAR(36)     NOT NULL,
  order_id              CHAR(36)     NOT NULL UNIQUE,
  referrer_user_id      CHAR(36)     NOT NULL,
  listing_id            VARCHAR(64)  NOT NULL,
  commission_mwk        INT UNSIGNED NOT NULL,
  buyer_discount_mwk    INT UNSIGNED NOT NULL DEFAULT 0,
  catalog_subtotal_mwk  INT UNSIGNED NOT NULL,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_re_earnings_referrer (referrer_user_id, created_at),
  CONSTRAINT fk_re_earnings_referral FOREIGN KEY (referral_id) REFERENCES listing_referrals(id),
  CONSTRAINT fk_re_earnings_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_re_earnings_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS referrer_payout_verifications (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  referrer_user_id    CHAR(36)     NOT NULL,
  amount_mwk          INT UNSIGNED NOT NULL,
  platform_fee_mwk    INT UNSIGNED NOT NULL DEFAULT 0,
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
  INDEX idx_rpv_referrer (referrer_user_id, status),
  CONSTRAINT fk_rpv_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS referrer_payouts (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  referrer_user_id     CHAR(36)     NOT NULL,
  amount_mwk           INT UNSIGNED NOT NULL,
  platform_fee_mwk     INT UNSIGNED NOT NULL DEFAULT 0,
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
  INDEX idx_rp_referrer_status (referrer_user_id, status),
  CONSTRAINT fk_rp_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE orders
  ADD COLUMN referral_id CHAR(36) NULL AFTER national_id,
  ADD COLUMN referral_code VARCHAR(64) NULL AFTER referral_id,
  ADD COLUMN catalog_subtotal_mwk INT UNSIGNED NULL AFTER referral_code,
  ADD COLUMN referral_discount_mwk INT UNSIGNED NOT NULL DEFAULT 0 AFTER catalog_subtotal_mwk,
  ADD COLUMN referrer_commission_mwk INT UNSIGNED NOT NULL DEFAULT 0 AFTER referral_discount_mwk,
  ADD CONSTRAINT fk_orders_referral FOREIGN KEY (referral_id) REFERENCES listing_referrals(id) ON DELETE SET NULL;

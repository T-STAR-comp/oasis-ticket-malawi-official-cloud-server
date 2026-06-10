-- Ticket tiers (Standard / VIP / VVIP etc.) + login OTP purpose

CREATE TABLE IF NOT EXISTS listing_ticket_tiers (
  id           CHAR(36)      NOT NULL PRIMARY KEY,
  listing_id   VARCHAR(64)   NOT NULL,
  name         VARCHAR(128)  NOT NULL,
  description  VARCHAR(512)  NULL DEFAULT NULL,
  price_mwk    INT UNSIGNED  NOT NULL,
  capacity     INT UNSIGNED  NULL DEFAULT NULL,
  sort_order   INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tiers_listing (listing_id),
  CONSTRAINT fk_tiers_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE order_items
  ADD COLUMN ticket_tier_id CHAR(36) NULL DEFAULT NULL AFTER seat_number;

ALTER TABLE user_tickets
  ADD COLUMN ticket_tier_id CHAR(36) NULL DEFAULT NULL AFTER listing_id,
  ADD COLUMN ticket_tier_name VARCHAR(128) NULL DEFAULT NULL AFTER ticket_tier_id;

ALTER TABLE email_verification_codes
  MODIFY COLUMN purpose ENUM('signup', 'password_reset', 'password_change', 'login') NOT NULL DEFAULT 'signup';

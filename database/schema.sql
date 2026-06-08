-- Ticket Malawi — MySQL schema
-- Matches ticket-malawi-app frontend entities

CREATE DATABASE IF NOT EXISTS ticket_malawi
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE ticket_malawi;

-- ---------------------------------------------------------------------------
-- Users & authentication
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  email             VARCHAR(255)  NOT NULL UNIQUE,
  username          VARCHAR(64)   NULL UNIQUE,
  password_hash     VARCHAR(255)  NOT NULL,
  full_name         VARCHAR(255)  NOT NULL,
  phone             VARCHAR(32)   NULL,
  national_id       VARCHAR(64)   NULL,
  role              ENUM('customer', 'organizer', 'admin') NOT NULL DEFAULT 'customer',
  status            ENUM('active', 'suspended', 'inactive') NOT NULL DEFAULT 'active',
  email_verified    TINYINT(1)    NOT NULL DEFAULT 0,
  email_verified_at TIMESTAMP     NULL,
  terms_accepted_at TIMESTAMP     NULL,
  terms_version     VARCHAR(32)   NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  code       CHAR(6)      NOT NULL,
  purpose    ENUM('signup', 'password_reset', 'password_change') NOT NULL DEFAULT 'signup',
  expires_at TIMESTAMP    NOT NULL,
  used_at    TIMESTAMP    NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_codes_user (user_id),
  CONSTRAINT fk_email_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_change_requests (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  user_id           CHAR(36)     NOT NULL,
  new_password_hash VARCHAR(255) NOT NULL,
  code              VARCHAR(6)   NOT NULL,
  expires_at        TIMESTAMP    NOT NULL,
  used_at           TIMESTAMP    NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pcr_user_active (user_id, used_at, expires_at),
  CONSTRAINT fk_pcr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NULL,
  email      VARCHAR(255) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP    NOT NULL,
  used_at    TIMESTAMP    NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_magic_link_email (email),
  CONSTRAINT fk_magic_link_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Organizer profiles & partner applications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizer_profiles (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  user_id       CHAR(36)     NOT NULL UNIQUE,
  company_name  VARCHAR(255) NOT NULL,
  contact_name  VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(32)  NOT NULL,
  partner_type  ENUM('events', 'travel', 'both') NOT NULL DEFAULT 'events',
  city          VARCHAR(128) NOT NULL,
  bio           TEXT         NULL,
  payout_bank_uuid VARCHAR(36) NULL,
  payout_bank_name VARCHAR(128) NULL,
  payout_account_name VARCHAR(255) NULL,
  payout_account_number VARCHAR(64) NULL,
  refund_debt_mwk       INT UNSIGNED NOT NULL DEFAULT 0,
  refund_recovered_mwk  INT UNSIGNED NOT NULL DEFAULT 0,
  status              ENUM('pending', 'approved', 'inactive', 'suspended', 'banned') NOT NULL DEFAULT 'pending',
  flagged_at          TIMESTAMP    NULL DEFAULT NULL,
  flag_reason         VARCHAR(255) NULL DEFAULT NULL,
  suspended_until     TIMESTAMP    NULL DEFAULT NULL,
  suspension_reason   VARCHAR(512) NULL DEFAULT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_organizer_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partner_applications (
  id                    CHAR(36)     NOT NULL PRIMARY KEY,
  partner_type          ENUM('events', 'travel', 'both') NOT NULL,
  company_name          VARCHAR(255) NOT NULL,
  trading_name          VARCHAR(255) NULL,
  registration_number   VARCHAR(128) NOT NULL,
  year_established      SMALLINT     NOT NULL,
  company_description   TEXT         NOT NULL,
  contact_name          VARCHAR(255) NOT NULL,
  job_title             VARCHAR(128) NOT NULL,
  contact_email         VARCHAR(255) NOT NULL,
  contact_phone         VARCHAR(32)  NOT NULL,
  city                  VARCHAR(128) NOT NULL,
  region                VARCHAR(128) NOT NULL,
  physical_address      TEXT         NOT NULL,
  monthly_volume        VARCHAR(64)  NOT NULL,
  website               VARCHAR(512) NULL,
  event_types           VARCHAR(512) NULL,
  fleet_info            VARCHAR(512) NULL,
  payment_methods       VARCHAR(512) NOT NULL,
  settlement_preference VARCHAR(255) NOT NULL,
  bank_name             VARCHAR(128) NULL,
  account_name          VARCHAR(255) NULL,
  account_number        VARCHAR(64)  NULL,
  branch                VARCHAR(128) NULL,
  additional_notes      TEXT         NULL,
  terms_accepted_at     TIMESTAMP    NULL,
  terms_version         VARCHAR(32)  NULL,
  status                ENUM('submitted', 'reviewing', 'approved', 'rejected') NOT NULL DEFAULT 'submitted',
  reviewed_by           CHAR(36)     NULL,
  reviewed_at           TIMESTAMP    NULL,
  admin_notes           TEXT         NULL,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_partner_apps_status (status),
  INDEX idx_partner_apps_email (contact_email),
  CONSTRAINT fk_partner_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Listings (events & travel routes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS listings (
  id               VARCHAR(64)   NOT NULL PRIMARY KEY,
  organizer_id     CHAR(36)      NOT NULL,
  kind             ENUM('event', 'travel') NOT NULL,
  title            VARCHAR(255)  NOT NULL,
  subtitle         VARCHAR(255)  NOT NULL,
  category         VARCHAR(128)  NOT NULL,
  date_label       VARCHAR(128)  NOT NULL,
  event_starts_on  DATE          NULL DEFAULT NULL,
  ticket_capacity  INT UNSIGNED  NULL DEFAULT NULL,
  time_label       VARCHAR(128)  NOT NULL,
  location         VARCHAR(255)  NOT NULL,
  price_mwk        INT UNSIGNED  NOT NULL,
  image_url        VARCHAR(1024) NOT NULL,
  description      TEXT          NOT NULL,
  operator_name    VARCHAR(255)  NOT NULL,
  operator_tagline VARCHAR(512)  NOT NULL,
  operator_detail  VARCHAR(512)  NOT NULL,
  route_from       VARCHAR(128)  NULL,
  route_to         VARCHAR(128)  NULL,
  route_duration   VARCHAR(64)   NULL,
  status           ENUM('published', 'draft', 'postponed', 'cancelled', 'sold_out') NOT NULL DEFAULT 'draft',
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_listings_kind_status (kind, status),
  INDEX idx_listings_organizer (organizer_id),
  CONSTRAINT fk_listings_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Travel seat layouts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS seat_layouts (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  listing_id   VARCHAR(64)  NOT NULL UNIQUE,
  total_seats  INT UNSIGNED NOT NULL,
  grid_cols    INT UNSIGNED NOT NULL DEFAULT 6,
  grid_rows    INT UNSIGNED NOT NULL DEFAULT 6,
  driver_side  ENUM('left', 'right') NOT NULL DEFAULT 'left',
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_seat_layout_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS seats (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  layout_id     CHAR(36)     NOT NULL,
  seat_number   INT UNSIGNED NOT NULL,
  grid_row      INT UNSIGNED NOT NULL DEFAULT 0,
  grid_col      INT UNSIGNED NOT NULL DEFAULT 0,
  status        ENUM('available', 'taken', 'unavailable') NOT NULL DEFAULT 'available',
  customer_name VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_layout_seat_number (layout_id, seat_number),
  INDEX idx_seats_layout_status (layout_id, status),
  CONSTRAINT fk_seats_layout FOREIGN KEY (layout_id) REFERENCES seat_layouts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Orders, purchases & payments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  user_id         CHAR(36)     NOT NULL,
  listing_id      VARCHAR(64)  NOT NULL,
  reference       VARCHAR(32)  NOT NULL UNIQUE,
  status          ENUM('pending', 'confirmed', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
  subtotal_mwk    INT UNSIGNED NOT NULL,
  service_fee_mwk INT UNSIGNED NOT NULL DEFAULT 500,
  total_mwk       INT UNSIGNED NOT NULL,
  payment_method  ENUM('airtel', 'tnm', 'card') NOT NULL,
  payment_phone   VARCHAR(32)  NULL,
  contact_name    VARCHAR(255) NOT NULL,
  contact_email   VARCHAR(255) NOT NULL,
  contact_phone   VARCHAR(32)  NOT NULL,
  national_id     VARCHAR(64)  NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_user (user_id),
  INDEX idx_orders_listing (listing_id),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_orders_listing FOREIGN KEY (listing_id) REFERENCES listings(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  order_id     CHAR(36)     NOT NULL,
  seat_id      CHAR(36)     NULL,
  seat_number  INT UNSIGNED NULL,
  quantity     INT UNSIGNED NOT NULL DEFAULT 1,
  unit_price   INT UNSIGNED NOT NULL,
  line_total   INT UNSIGNED NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_seat FOREIGN KEY (seat_id) REFERENCES seats(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- User-facing ticket state (active / used / expired)
CREATE TABLE IF NOT EXISTS user_tickets (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  user_id      CHAR(36)     NOT NULL,
  order_id     CHAR(36)     NOT NULL,
  listing_id   VARCHAR(64)  NOT NULL,
  reference    VARCHAR(32)  NOT NULL,
  qr_token     VARCHAR(64)  NOT NULL,
  status               ENUM('active', 'used', 'expired') NOT NULL DEFAULT 'active',
  verified_at          TIMESTAMP    NULL DEFAULT NULL,
  verified_by_user_id  CHAR(36)     NULL DEFAULT NULL,
  seat_number          INT UNSIGNED NULL,
  amount_paid          INT UNSIGNED NOT NULL,
  purchased_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_tickets_qr (qr_token),
  INDEX idx_user_tickets_user_status (user_id, status),
  INDEX idx_user_tickets_reference (reference),
  CONSTRAINT fk_user_tickets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_tickets_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_user_tickets_listing FOREIGN KEY (listing_id) REFERENCES listings(id),
  CONSTRAINT fk_user_tickets_verified_by FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Ticket verification (gate scans & delegated verifiers)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS listing_verifier_assignments (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  listing_id       VARCHAR(64)  NOT NULL,
  organizer_id     CHAR(36)     NOT NULL,
  verifier_user_id CHAR(36)     NOT NULL,
  status           ENUM('active', 'revoked', 'expired') NOT NULL DEFAULT 'active',
  expires_at       TIMESTAMP    NOT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at       TIMESTAMP    NULL,
  INDEX idx_lva_listing_active (listing_id, status, expires_at),
  INDEX idx_lva_verifier (verifier_user_id, status, expires_at),
  CONSTRAINT fk_lva_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_lva_organizer FOREIGN KEY (organizer_id) REFERENCES users(id),
  CONSTRAINT fk_lva_verifier FOREIGN KEY (verifier_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_verifications (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  user_ticket_id      CHAR(36)     NOT NULL,
  listing_id          VARCHAR(64)  NOT NULL,
  verified_by_user_id CHAR(36)     NOT NULL,
  method              ENUM('reference', 'qr_scan') NOT NULL,
  result              ENUM('accepted', 'rejected') NOT NULL,
  reject_reason       VARCHAR(64)  NULL,
  reference           VARCHAR(32)  NULL,
  qr_token            VARCHAR(64)  NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tv_ticket (user_ticket_id),
  INDEX idx_tv_listing_time (listing_id, created_at),
  CONSTRAINT fk_tv_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id),
  CONSTRAINT fk_tv_verifier FOREIGN KEY (verified_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS checkout_queue (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  listing_id        VARCHAR(64)  NOT NULL,
  user_id           CHAR(36)     NOT NULL,
  qty               INT UNSIGNED NOT NULL DEFAULT 1,
  seat_numbers      JSON         NULL,
  status            ENUM('waiting', 'ready', 'completed', 'expired', 'cancelled') NOT NULL DEFAULT 'waiting',
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at          TIMESTAMP    NULL,
  ready_expires_at  TIMESTAMP    NULL,
  completed_at      TIMESTAMP    NULL,
  INDEX idx_cq_listing_waiting (listing_id, status, created_at),
  INDEX idx_cq_user_listing (user_id, listing_id, status),
  CONSTRAINT fk_cq_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_cq_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_reminder_log (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  user_ticket_id CHAR(36)     NOT NULL,
  listing_id     VARCHAR(64)  NOT NULL,
  days_before    TINYINT      NOT NULL,
  sent_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reminder_ticket_days (user_ticket_id, days_before),
  CONSTRAINT fk_trl_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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

CREATE TABLE IF NOT EXISTS ticket_shares (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  user_ticket_id    CHAR(36)     NOT NULL,
  shared_by_user_id CHAR(36)     NOT NULL,
  recipient_email   VARCHAR(255) NOT NULL,
  status            ENUM('sent', 'accepted', 'revoked') NOT NULL DEFAULT 'sent',
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticket_shares_recipient (recipient_email),
  CONSTRAINT fk_shares_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_user FOREIGN KEY (shared_by_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payout_verifications (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id        CHAR(36)     NOT NULL,
  amount_mwk          INT UNSIGNED NOT NULL,
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
  INDEX idx_payout_verify_organizer (organizer_id, status),
  CONSTRAINT fk_payout_verify_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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

CREATE TABLE IF NOT EXISTS payment_methods (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  user_id         CHAR(36)     NOT NULL,
  type            ENUM('airtel', 'tnm', 'card') NOT NULL,
  label           VARCHAR(128) NOT NULL,
  details_masked  VARCHAR(255) NOT NULL,
  is_default      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payment_methods_user (user_id),
  CONSTRAINT fk_payment_methods_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS organizer_reports (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  reporter_user_id CHAR(36)     NOT NULL,
  organizer_id     CHAR(36)     NOT NULL,
  listing_id       VARCHAR(64)  NULL,
  reason           ENUM(
    'fraudulent_listing', 'misleading_information', 'no_show_or_cancellation',
    'harassment_or_abuse', 'unsafe_or_illegal_content', 'payment_or_refund_issue',
    'spam_or_scam', 'poor_service', 'other'
  ) NOT NULL,
  details          TEXT         NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_or_organizer_reason (organizer_id, reason),
  CONSTRAINT fk_or_reporter FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_or_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_or_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS organizer_flags (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id    CHAR(36)     NOT NULL,
  flag_type       ENUM('report_threshold', 'mass_report', 'content_violation', 'admin') NOT NULL,
  report_count    INT UNSIGNED NOT NULL DEFAULT 0,
  primary_reason  VARCHAR(64)  NULL,
  status          ENUM('active', 'reviewed', 'removed') NOT NULL DEFAULT 'active',
  admin_notes     TEXT         NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at     TIMESTAMP    NULL,
  reviewed_by     CHAR(36)     NULL,
  removed_at      TIMESTAMP    NULL,
  CONSTRAINT fk_of_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS organizer_appeals (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id CHAR(36)     NOT NULL,
  appeal_type  ENUM('suspension', 'ban') NOT NULL DEFAULT 'suspension',
  reason       TEXT         NOT NULL,
  status       ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  admin_notes  TEXT         NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at  TIMESTAMP    NULL,
  reviewed_by  CHAR(36)     NULL,
  CONSTRAINT fk_oa_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_refunds (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  user_id         CHAR(36)     NOT NULL,
  user_ticket_id  CHAR(36)     NOT NULL,
  order_id        CHAR(36)     NOT NULL,
  organizer_id    CHAR(36)     NOT NULL,
  original_amount INT UNSIGNED NOT NULL,
  refund_amount   INT UNSIGNED NOT NULL,
  processing_fee  INT UNSIGNED NOT NULL,
  platform_fee    INT UNSIGNED NOT NULL,
  status          ENUM('pending', 'completed', 'skipped') NOT NULL DEFAULT 'pending',
  skip_reason     VARCHAR(255) NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    TIMESTAMP    NULL,
  CONSTRAINT fk_tr_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_tr_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id),
  CONSTRAINT fk_tr_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_tr_organizer FOREIGN KEY (organizer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refund_recovery_allocations (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id     CHAR(36)     NOT NULL,
  order_id         CHAR(36)     NULL,
  ticket_refund_id CHAR(36)     NULL,
  amount_mwk       INT UNSIGNED NOT NULL,
  source           ENUM('settled_sale', 'cancelled_hold') NOT NULL DEFAULT 'settled_sale',
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rra_organizer (organizer_id, created_at),
  CONSTRAINT fk_rra_organizer FOREIGN KEY (organizer_id) REFERENCES users(id),
  CONSTRAINT fk_rra_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_rra_refund FOREIGN KEY (ticket_refund_id) REFERENCES ticket_refunds(id) ON DELETE SET NULL
) ENGINE=InnoDB;

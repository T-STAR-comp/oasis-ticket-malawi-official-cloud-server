-- v9: Organizer moderation — reports, flags, appeals, refunds, ban support

USE ticket_malawi;

ALTER TABLE organizer_profiles
  MODIFY status ENUM('pending', 'approved', 'inactive', 'suspended', 'banned') NOT NULL DEFAULT 'pending';

ALTER TABLE organizer_profiles
  ADD COLUMN flagged_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN flag_reason VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN suspended_until TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN suspension_reason VARCHAR(512) NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS organizer_reports (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  reporter_user_id CHAR(36)    NOT NULL,
  organizer_id    CHAR(36)     NOT NULL,
  listing_id      VARCHAR(64)  NULL,
  reason          ENUM(
    'fraudulent_listing',
    'misleading_information',
    'no_show_or_cancellation',
    'harassment_or_abuse',
    'unsafe_or_illegal_content',
    'payment_or_refund_issue',
    'spam_or_scam',
    'poor_service',
    'other'
  ) NOT NULL,
  details         TEXT         NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_or_organizer_reason (organizer_id, reason),
  INDEX idx_or_reporter (reporter_user_id, organizer_id),
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
  INDEX idx_of_organizer_status (organizer_id, status),
  CONSTRAINT fk_of_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_of_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS organizer_appeals (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id    CHAR(36)     NOT NULL,
  appeal_type     ENUM('suspension', 'ban') NOT NULL DEFAULT 'suspension',
  reason          TEXT         NOT NULL,
  status          ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  admin_notes     TEXT         NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at     TIMESTAMP    NULL,
  reviewed_by     CHAR(36)     NULL,
  INDEX idx_oa_organizer_status (organizer_id, status),
  CONSTRAINT fk_oa_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_oa_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_refunds (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  user_id           CHAR(36)     NOT NULL,
  user_ticket_id    CHAR(36)     NOT NULL,
  order_id          CHAR(36)     NOT NULL,
  organizer_id      CHAR(36)     NOT NULL,
  original_amount   INT UNSIGNED NOT NULL,
  refund_amount     INT UNSIGNED NOT NULL,
  processing_fee    INT UNSIGNED NOT NULL,
  platform_fee      INT UNSIGNED NOT NULL,
  status            ENUM('pending', 'completed', 'skipped') NOT NULL DEFAULT 'pending',
  skip_reason       VARCHAR(255) NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at      TIMESTAMP    NULL,
  INDEX idx_tr_organizer (organizer_id),
  INDEX idx_tr_user (user_id),
  CONSTRAINT fk_tr_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_tr_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id),
  CONSTRAINT fk_tr_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_tr_organizer FOREIGN KEY (organizer_id) REFERENCES users(id)
) ENGINE=InnoDB;

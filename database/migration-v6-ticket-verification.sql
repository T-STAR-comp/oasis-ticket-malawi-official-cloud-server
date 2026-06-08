-- Ticket verification: gate scans + temporary verifier assignments (24h)

ALTER TABLE user_tickets
  ADD COLUMN verified_at TIMESTAMP NULL DEFAULT NULL AFTER status,
  ADD COLUMN verified_by_user_id CHAR(36) NULL DEFAULT NULL AFTER verified_at,
  ADD INDEX idx_user_tickets_reference (reference);

ALTER TABLE user_tickets
  ADD CONSTRAINT fk_user_tickets_verified_by
    FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

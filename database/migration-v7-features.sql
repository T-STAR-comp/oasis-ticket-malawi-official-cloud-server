-- Event reminders, driver side, password change verification, reminder log

ALTER TABLE listings
  ADD COLUMN event_starts_on DATE NULL DEFAULT NULL AFTER date_label;

ALTER TABLE seat_layouts
  ADD COLUMN driver_side ENUM('left', 'right') NOT NULL DEFAULT 'left' AFTER grid_rows;

ALTER TABLE email_verification_codes
  MODIFY COLUMN purpose ENUM('signup', 'password_reset', 'password_change') NOT NULL DEFAULT 'signup';

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_reminder_log (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  user_ticket_id CHAR(36)     NOT NULL,
  listing_id     VARCHAR(64)  NOT NULL,
  days_before    TINYINT      NOT NULL,
  sent_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reminder_ticket_days (user_ticket_id, days_before),
  CONSTRAINT fk_trl_ticket FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

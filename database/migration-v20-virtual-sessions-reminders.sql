ALTER TABLE listings
  ADD COLUMN virtual_event_type ENUM('one_time','ongoing') NOT NULL DEFAULT 'one_time' AFTER event_format,
  ADD COLUMN virtual_buy_mode ENUM('bundle_only','allow_session_selection') NOT NULL DEFAULT 'bundle_only' AFTER virtual_event_type,
  ADD COLUMN virtual_pricing_mode ENUM('uniform','per_session') NOT NULL DEFAULT 'uniform' AFTER virtual_buy_mode,
  ADD COLUMN virtual_first_session_verified_at DATETIME NULL DEFAULT NULL AFTER virtual_duration_minutes,
  ADD COLUMN virtual_first_session_verified_by CHAR(36) NULL DEFAULT NULL AFTER virtual_first_session_verified_at;

CREATE TABLE IF NOT EXISTS virtual_event_sessions (
  id CHAR(36) PRIMARY KEY,
  listing_id CHAR(36) NOT NULL,
  session_index INT NOT NULL,
  title VARCHAR(160) NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  meeting_url TEXT NULL,
  price_mwk INT NOT NULL DEFAULT 0,
  status ENUM('scheduled','rescheduled','cancelled') NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_virtual_event_session_idx (listing_id, session_index),
  KEY idx_virtual_event_session_start (starts_at),
  CONSTRAINT fk_virtual_event_sessions_listing
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS virtual_join_reminder_log (
  id CHAR(36) PRIMARY KEY,
  user_ticket_id CHAR(36) NULL,
  listing_id CHAR(36) NOT NULL,
  session_id CHAR(36) NULL,
  reminder_kind ENUM('attendee_prestart','organizer_missing_link') NOT NULL,
  reminder_bucket VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_virtual_join_reminder (user_ticket_id, listing_id, reminder_kind, reminder_bucket),
  KEY idx_virtual_join_reminder_listing (listing_id),
  KEY idx_virtual_join_reminder_session (session_id),
  CONSTRAINT fk_virtual_join_reminder_ticket
    FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_virtual_join_reminder_listing
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_virtual_join_reminder_session
    FOREIGN KEY (session_id) REFERENCES virtual_event_sessions(id) ON DELETE CASCADE
);

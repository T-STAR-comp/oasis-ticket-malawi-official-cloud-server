-- Ticket capacity, checkout queue for high-traffic purchases

ALTER TABLE listings
  ADD COLUMN ticket_capacity INT UNSIGNED NULL DEFAULT NULL AFTER event_starts_on;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

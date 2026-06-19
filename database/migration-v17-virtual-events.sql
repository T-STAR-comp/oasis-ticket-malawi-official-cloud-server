-- Virtual events: online format with meeting link and timed access window
ALTER TABLE listings
  ADD COLUMN event_format ENUM('physical', 'virtual') NOT NULL DEFAULT 'physical' AFTER kind,
  ADD COLUMN virtual_meeting_url VARCHAR(2048) NULL DEFAULT NULL AFTER location,
  ADD COLUMN virtual_duration_minutes INT UNSIGNED NULL DEFAULT NULL AFTER virtual_meeting_url;

CREATE INDEX idx_listings_event_format ON listings (kind, event_format, status);

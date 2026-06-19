-- Virtual event payout verification: funds stay locked until admin verifies after the event
ALTER TABLE listings
  ADD COLUMN virtual_payout_verified_at TIMESTAMP NULL DEFAULT NULL AFTER virtual_duration_minutes,
  ADD COLUMN virtual_payout_verified_by VARCHAR(36) NULL DEFAULT NULL AFTER virtual_payout_verified_at;

CREATE INDEX idx_listings_virtual_payout ON listings (event_format, virtual_payout_verified_at);

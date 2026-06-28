-- Reserve resale listings while a buyer completes payment (prevents double-buy races).

ALTER TABLE resell_listings
  MODIFY status ENUM('active', 'pending_sale', 'sold', 'cancelled') NOT NULL DEFAULT 'active',
  ADD COLUMN pending_buyer_id CHAR(36) NULL DEFAULT NULL AFTER status,
  ADD COLUMN pending_order_id CHAR(36) NULL DEFAULT NULL AFTER pending_buyer_id,
  ADD COLUMN pending_expires_at TIMESTAMP NULL DEFAULT NULL AFTER pending_order_id,
  ADD INDEX idx_resell_pending (status, pending_expires_at);

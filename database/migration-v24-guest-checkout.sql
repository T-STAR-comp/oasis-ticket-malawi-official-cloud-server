-- Guest checkout: nullable buyer account + queue guest keys + order access tokens

ALTER TABLE orders MODIFY user_id CHAR(36) NULL;
ALTER TABLE orders ADD COLUMN is_guest TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN guest_access_token CHAR(64) NULL;
ALTER TABLE orders ADD INDEX idx_orders_guest_token (guest_access_token);

ALTER TABLE user_tickets MODIFY user_id CHAR(36) NULL;
ALTER TABLE user_tickets ADD COLUMN guest_email VARCHAR(255) NULL;
ALTER TABLE user_tickets ADD INDEX idx_user_tickets_guest_email (guest_email);

ALTER TABLE payment_ledger MODIFY user_id CHAR(36) NULL;

ALTER TABLE checkout_queue MODIFY user_id CHAR(36) NULL;
ALTER TABLE checkout_queue ADD COLUMN guest_key VARCHAR(64) NULL;
ALTER TABLE checkout_queue ADD INDEX idx_cq_guest_key (listing_id, guest_key, status);

ALTER TABLE self_checkin_events MODIFY holder_user_id CHAR(36) NULL;

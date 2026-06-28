-- Platform service fee settings: bearer (buyer vs organizer), custom organizer rates, dynamic ranges.

CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by CHAR(36) NULL
);

INSERT INTO platform_settings (setting_key, setting_value) VALUES
  ('service_fee_bearer', 'buyer'),
  ('dynamic_service_fee_enabled', 'false')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

CREATE TABLE IF NOT EXISTS organizer_custom_service_fees (
  organizer_user_id CHAR(36) NOT NULL PRIMARY KEY,
  fee_percent DECIMAL(5,2) NOT NULL,
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by CHAR(36) NULL,
  CONSTRAINT fk_org_custom_fee_user FOREIGN KEY (organizer_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dynamic_service_fee_ranges (
  id CHAR(36) NOT NULL PRIMARY KEY,
  min_mwk INT UNSIGNED NOT NULL,
  max_mwk INT UNSIGNED NULL DEFAULT NULL,
  fee_percent DECIMAL(5,2) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE orders
  ADD COLUMN service_fee_bearer ENUM('buyer', 'organizer') NOT NULL DEFAULT 'buyer' AFTER service_fee_mwk,
  ADD COLUMN service_fee_percent_applied DECIMAL(5,2) NULL DEFAULT NULL AFTER service_fee_bearer;

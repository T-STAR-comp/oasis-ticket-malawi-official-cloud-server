-- Run this against your EXISTING ticket_malawi database
USE ticket_malawi;

-- Users: username, account status, email verification
ALTER TABLE users
  ADD COLUMN username VARCHAR(64) NULL UNIQUE AFTER email,
  ADD COLUMN status ENUM('active', 'suspended', 'inactive') NOT NULL DEFAULT 'active' AFTER role,
  ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN email_verified_at TIMESTAMP NULL AFTER email_verified;

ALTER TABLE users ADD INDEX idx_users_status (status);

-- Existing accounts are treated as already verified
UPDATE users
SET email_verified = 1, email_verified_at = COALESCE(created_at, NOW())
WHERE email_verified = 0;

-- Organizer profile status: add inactive
ALTER TABLE organizer_profiles
  MODIFY COLUMN status ENUM('pending', 'approved', 'inactive', 'suspended') NOT NULL DEFAULT 'pending';

UPDATE organizer_profiles SET status = 'approved' WHERE status = 'pending';

-- Partner application review fields
ALTER TABLE partner_applications
  ADD COLUMN reviewed_by CHAR(36) NULL AFTER status,
  ADD COLUMN reviewed_at TIMESTAMP NULL AFTER reviewed_by,
  ADD COLUMN admin_notes TEXT NULL AFTER reviewed_at;

ALTER TABLE partner_applications
  ADD CONSTRAINT fk_partner_reviewed_by
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

-- Email verification codes (6-digit)
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  code       CHAR(6)      NOT NULL,
  purpose    ENUM('signup', 'password_reset') NOT NULL DEFAULT 'signup',
  expires_at TIMESTAMP    NOT NULL,
  used_at    TIMESTAMP    NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_codes_user (user_id),
  INDEX idx_email_codes_code (code),
  CONSTRAINT fk_email_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

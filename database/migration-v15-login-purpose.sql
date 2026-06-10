-- Add login purpose for sign-in OTP (safe to re-run)
ALTER TABLE email_verification_codes
  MODIFY COLUMN purpose ENUM('signup', 'password_reset', 'password_change', 'login') NOT NULL DEFAULT 'signup';

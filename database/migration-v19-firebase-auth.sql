-- Firebase Auth: link Firebase UIDs to platform users
ALTER TABLE users
  ADD COLUMN firebase_uid VARCHAR(128) NULL DEFAULT NULL AFTER email,
  MODIFY COLUMN password_hash VARCHAR(255) NULL DEFAULT NULL;

CREATE UNIQUE INDEX idx_users_firebase_uid ON users (firebase_uid);

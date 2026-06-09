-- Careers: admin-posted job openings with configurable application fields.

CREATE TABLE IF NOT EXISTS job_posts (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  slug                VARCHAR(128) NOT NULL UNIQUE,
  title               VARCHAR(255) NOT NULL,
  department          VARCHAR(128) NULL,
  location            VARCHAR(128) NULL,
  employment_type     ENUM('full_time', 'part_time', 'contract', 'internship', 'other') NULL,
  description         TEXT         NOT NULL,
  requirements        TEXT         NULL,
  benefits            TEXT         NULL,
  apply_email         VARCHAR(255) NOT NULL,
  application_fields  JSON         NOT NULL,
  status              ENUM('draft', 'published', 'closed') NOT NULL DEFAULT 'draft',
  published_at        TIMESTAMP    NULL,
  closes_at           TIMESTAMP    NULL,
  created_by          CHAR(36)     NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_job_posts_status (status, published_at),
  CONSTRAINT fk_job_posts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

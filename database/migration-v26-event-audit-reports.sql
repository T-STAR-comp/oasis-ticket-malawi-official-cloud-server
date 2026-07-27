CREATE TABLE IF NOT EXISTS event_audit_reports (
  id CHAR(36) PRIMARY KEY,
  listing_id CHAR(36) NOT NULL,
  organizer_id CHAR(36) NOT NULL,
  trigger_kind ENUM('auto', 'manual') NOT NULL DEFAULT 'auto',
  triggered_by CHAR(36) NULL DEFAULT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  pdf_filename VARCHAR(255) NOT NULL,
  report_summary_json JSON NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_event_audit_listing (listing_id),
  KEY idx_event_audit_organizer (organizer_id),
  KEY idx_event_audit_sent (sent_at),
  CONSTRAINT fk_event_audit_listing
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_event_audit_organizer
    FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

UPDATE listings
SET event_layout_json = NULL
WHERE event_format = 'virtual' AND event_layout_json IS NOT NULL;

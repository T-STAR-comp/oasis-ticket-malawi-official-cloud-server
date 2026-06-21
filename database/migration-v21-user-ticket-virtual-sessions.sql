CREATE TABLE IF NOT EXISTS user_ticket_virtual_sessions (
  id CHAR(36) PRIMARY KEY,
  user_ticket_id CHAR(36) NOT NULL,
  session_id CHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_ticket_virtual_session (user_ticket_id, session_id),
  KEY idx_utvs_session (session_id),
  CONSTRAINT fk_utvs_user_ticket
    FOREIGN KEY (user_ticket_id) REFERENCES user_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_utvs_virtual_session
    FOREIGN KEY (session_id) REFERENCES virtual_event_sessions(id) ON DELETE CASCADE
);

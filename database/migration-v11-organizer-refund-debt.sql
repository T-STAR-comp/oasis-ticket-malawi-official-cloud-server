-- Organizer refund debt: liability when payouts exceed held cancellation funds.
-- New settled sales recover debt before becoming withdrawable.

ALTER TABLE organizer_profiles
  ADD COLUMN refund_debt_mwk INT UNSIGNED NOT NULL DEFAULT 0 AFTER payout_account_number,
  ADD COLUMN refund_recovered_mwk INT UNSIGNED NOT NULL DEFAULT 0 AFTER refund_debt_mwk;

CREATE TABLE IF NOT EXISTS refund_recovery_allocations (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  organizer_id     CHAR(36)     NOT NULL,
  order_id         CHAR(36)     NULL,
  ticket_refund_id CHAR(36)     NULL,
  amount_mwk       INT UNSIGNED NOT NULL,
  source           ENUM('settled_sale', 'cancelled_hold') NOT NULL DEFAULT 'settled_sale',
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rra_organizer (organizer_id, created_at),
  CONSTRAINT fk_rra_organizer FOREIGN KEY (organizer_id) REFERENCES users(id),
  CONSTRAINT fk_rra_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_rra_refund FOREIGN KEY (ticket_refund_id) REFERENCES ticket_refunds(id) ON DELETE SET NULL
) ENGINE=InnoDB;

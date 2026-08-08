-- E-Sports tournament slot capacity
USE ticket_malawi;

ALTER TABLE esports_events
  ADD COLUMN max_slots INT UNSIGNED NOT NULL DEFAULT 32 AFTER grand_prize_mwk;

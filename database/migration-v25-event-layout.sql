-- Optional spatial layout for physical events (stage/screen + seat spots).
ALTER TABLE listings
  ADD COLUMN event_layout_json JSON NULL AFTER ticket_capacity;

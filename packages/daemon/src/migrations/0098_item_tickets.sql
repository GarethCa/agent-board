-- backward-safe: it only adds a nullable column and a partial index, which an older daemon never reads.
-- A board item's level: the session id of the ticket chat whose own board it sits on, NULL for the main board. No
-- foreign key, as with agents.ticket: the daemon deletes a ticket's items through its own item removal, with its events.
ALTER TABLE board_items ADD COLUMN ticket TEXT;
CREATE INDEX board_items_ticket ON board_items (ticket) WHERE ticket IS NOT NULL;

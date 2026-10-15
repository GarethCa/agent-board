-- A named hand-off (the governance review's G28): `board.handoff` with `to` an agent it has no edge to makes a
-- manual edge for it, marked as made by the agent and as a one-off, so it is drawn afterwards with what it carried.
ALTER TABLE flow_edges ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0 CHECK (one_off IN (0, 1));
-- What its last named hand-off carried, kept so the user's Send replays it after a restart too: a message or JSON
-- handed inline is no file to read again.
ALTER TABLE flow_edges ADD COLUMN one_off_name TEXT;
ALTER TABLE flow_edges ADD COLUMN one_off_text TEXT;

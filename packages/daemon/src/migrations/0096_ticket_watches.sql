-- backward-safe: it only adds two nullable columns, which an older daemon never reads or writes.
-- A ticket's watches: what its chat's pull request it reports, and where. `watches` is the settings as JSON (each kind's
-- On tile and Tell chat switches, and how often to check), NULL while none is on. `watch_state` is what the last check
-- saw, the news the tile has not shown yet and the news the chat has not been told yet, as JSON. Both are on the
-- ticket's chat, the one agent the ticket is.
ALTER TABLE agents ADD COLUMN watches TEXT;
ALTER TABLE agents ADD COLUMN watch_state TEXT;

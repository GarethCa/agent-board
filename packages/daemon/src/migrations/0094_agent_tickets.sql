-- backward-safe: it only adds two columns with defaults and an index, which an older daemon never reads or writes.
-- A ticket tile is one agent, its chat (`ticket_chat` 1), and its helpers: the agents the chat starts, and theirs, each
-- with `ticket` set to the chat's session id. A ticket's chat is in no other ticket. Removing the chat clears its
-- helpers' `ticket`, so none names a ticket that is gone.
ALTER TABLE agents ADD COLUMN ticket TEXT;
ALTER TABLE agents ADD COLUMN ticket_chat INTEGER NOT NULL DEFAULT 0;
-- Few agents are helpers: the index holds only those, for finding a ticket's helpers.
CREATE INDEX agents_ticket ON agents (ticket) WHERE ticket IS NOT NULL;

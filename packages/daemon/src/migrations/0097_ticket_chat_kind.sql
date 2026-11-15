-- backward-safe: it only adds a column with a default and a nullable one, which an older daemon never reads or writes.
-- A ticket's chat is one of two kinds: the implementer, which writes the ticket's code itself (`ticket_lead` 0, which
-- every chat before this was), or its own lead, whose builder helper writes it on the chat's branch (`ticket_lead` 1).
-- `chat_switch` is the kind it switches to at its next hand-off, while that waits for one; NULL while none waits.
ALTER TABLE agents ADD COLUMN ticket_lead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN chat_switch TEXT;

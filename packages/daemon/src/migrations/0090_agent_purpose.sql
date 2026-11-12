-- backward-safe: a new nullable column, which an older daemon never reads or writes.
-- What an agent says it is for (`Agent.purpose`), at most 80 characters: set with `status set --description` or
-- `set_status`'s `description`, by the agent or its orchestrator, and kept until it is set again. NULL while it has none.
ALTER TABLE agents ADD COLUMN purpose TEXT;

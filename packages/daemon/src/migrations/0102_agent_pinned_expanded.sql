-- backward-safe: it only adds a column with a default, which an older daemon never reads.
-- Whether the agent is pinned expanded: its tile stays expanded where it is, at its size, and opens again by itself
-- whenever it is back (after a restart of the app or the agent, a closed window, a reconnect). 1 while pinned. An
-- agent that is closed, its session ended with nothing left, drops it.
ALTER TABLE agents ADD COLUMN pinned_expanded INTEGER NOT NULL DEFAULT 0;

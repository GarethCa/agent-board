-- backward-safe: a column with a default, which an older daemon leaves alone.
-- Whether the board heard no hook from an agent's session in its first minute, and none since: kept through a restart
-- of the daemon or the agent, so its tile goes on saying the board can't follow its turns until a hook arrives.
ALTER TABLE agents ADD COLUMN hooks_silent INTEGER NOT NULL DEFAULT 0;

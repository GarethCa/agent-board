-- When the agent was paused (hibernated: its session ended to free what its harness held, until it is woken), and by
-- whom: the name of the orchestrator that paused it, or NULL for the user. Both NULL while it is not paused.
ALTER TABLE agents ADD COLUMN hibernated_at TEXT;
ALTER TABLE agents ADD COLUMN hibernated_by TEXT;

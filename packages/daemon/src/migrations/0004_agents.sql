-- An agent: a session running a harness (sessions.harness) in its own git worktree, drawn as a tile in a zone.
-- The row outlives the session, so an ended agent keeps its tile until it is deleted, which also removes its worktree
-- and branch. state is the agent state its hooks last put it in (ADR-0004).
CREATE TABLE agents (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id),
  zone_id TEXT NOT NULL REFERENCES zones (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'thinking', 'waiting', 'needs-permission', 'idle', 'rate-limited', 'failed', 'done'))
);

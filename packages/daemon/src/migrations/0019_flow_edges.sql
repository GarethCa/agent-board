-- A flow edge: a directed flow from one agent to another that delivers the first's payload to the second as
-- its next message, by itself when the first hands off (`auto`) or when the user sends it (`manual`). Both ends are
-- agents, so they are real foreign keys, and an edge goes with either agent. Its last delivery, if any, is kept: when,
-- and why it was skipped (NULL when it was delivered).
CREATE TABLE flow_edges (
  id TEXT PRIMARY KEY,
  from_session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  to_session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivered_at TEXT,
  skipped_because TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (from_session_id, to_session_id)
);
CREATE INDEX flow_edges_to ON flow_edges (to_session_id);

-- Edge rules. A flow edge may carry a file from its `from` agent's worktree (`path`, relative to it), and hold
-- an auto hand-off until its `conditions` (a JSON array) pass: the held payload, as read when it was handed off, its
-- name, since when, and why. Each edge keeps what happened along it in `flow_edge_events`, going with it.
ALTER TABLE flow_edges ADD COLUMN path TEXT;
ALTER TABLE flow_edges ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE flow_edges ADD COLUMN held_name TEXT;
ALTER TABLE flow_edges ADD COLUMN held_text TEXT;
ALTER TABLE flow_edges ADD COLUMN held_since TEXT;
ALTER TABLE flow_edges ADD COLUMN held_reason TEXT;

CREATE TABLE flow_edge_events (
  id INTEGER PRIMARY KEY,
  edge_id TEXT NOT NULL REFERENCES flow_edges (id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX flow_edge_events_edge ON flow_edge_events (edge_id, id);

-- An agent's final message from the turn it last finished, so a manual edge can still send it after a restart.
ALTER TABLE agents ADD COLUMN final_message TEXT;

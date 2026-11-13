-- backward-safe: it only adds a nullable column, its index and a table, which an older daemon never reads or writes.
-- An orchestrator's crew outlives it: removing it nulls each crew agent's `spawned_by`, as before, and sets its
-- `orphaned_from` to the removed orchestrator's session id, so the crew stays apart from the agents the user started
-- (for whom both are NULL) and another orchestrator may take it over (`orchestrate handover <removed> <to>`). Taking it over
-- sets `spawned_by` to the taker and clears `orphaned_from`.
ALTER TABLE agents ADD COLUMN orphaned_from TEXT;
-- Few agents are orphaned at a time: the index holds only those, for finding a removed orchestrator's crew.
CREATE INDEX agents_orphaned_from ON agents (orphaned_from) WHERE orphaned_from IS NOT NULL;
-- What a handover needs of a removed orchestrator whose crew is still on the board: its name, the scope it orchestrated
-- at (NULL for none) and how deep in a crew it was. A row goes once no agent names it in `orphaned_from`.
CREATE TABLE removed_orchestrators (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  orchestrate TEXT CHECK (orchestrate IN ('zone', 'repo', 'board')),
  crew_depth INTEGER NOT NULL,
  removed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

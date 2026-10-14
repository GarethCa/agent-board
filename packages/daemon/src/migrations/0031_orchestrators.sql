-- Orchestrators: an agent the user lets start, message and watch other agents through the board CLI and MCP.
-- `orchestrate` is its scope ('zone', 'repo' or 'board'), NULL while it may not; only the user sets it. `spawned_by`
-- is the orchestrator that started an agent, NULL for one the user started (or once its orchestrator is deleted).
ALTER TABLE agents ADD COLUMN orchestrate TEXT CHECK (orchestrate IN ('zone', 'repo', 'board'));
ALTER TABLE agents ADD COLUMN spawned_by TEXT;

-- What orchestrators did and tried, oldest first, append-only: who, what, to whom, when, and whether it was done or
-- refused (and why). Names are kept as they were, since agents are deleted and renamed.
CREATE TABLE orchestrator_activity (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  orchestrator_id TEXT NOT NULL,
  orchestrator_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  detail TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'refused')),
  reason TEXT
);
CREATE INDEX orchestrator_activity_by_orchestrator ON orchestrator_activity (orchestrator_id, id);

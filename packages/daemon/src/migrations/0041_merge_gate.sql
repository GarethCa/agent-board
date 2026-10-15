-- The merge gate. A zone's gate command, run in an agent's worktree when the user asks (NULL for none); and the
-- latest gate run of each agent, as JSON (`GateRun`), which goes with its agent. Its logs are files under the data dir.
ALTER TABLE zones ADD COLUMN gate_command TEXT;
CREATE TABLE gate_runs (
  session_id TEXT PRIMARY KEY REFERENCES agents (session_id) ON DELETE CASCADE,
  run TEXT NOT NULL
);

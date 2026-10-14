-- A long-lived agent's cron schedule. At each fire time the daemon starts
-- a run: it sends prompt to the agent as its next message. One schedule per agent, deleted with it. cron is a
-- five-field expression in the daemon's local time (src/cron.ts). A disabled schedule keeps its settings but never fires.
CREATE TABLE schedules (
  session_id TEXT PRIMARY KEY REFERENCES agents (session_id) ON DELETE CASCADE,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Each time a schedule fired: due_at is the fire time it was due at, fired_at when it went off (later if the machine
-- slept through it). outcome says whether it started a run, or skipped because the agent was busy (reason says why).
CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'skipped')),
  reason TEXT
);

CREATE INDEX schedule_runs_by_agent ON schedule_runs (session_id, id);

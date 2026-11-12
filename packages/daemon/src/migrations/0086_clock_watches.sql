-- backward-safe: it only adds columns with defaults to clock_runs and a table, which an older daemon never reads.
-- A clock's run that messages its agent now waits for the turn it started to end (awaits_turn), keeping that turn's
-- final message in result and when it ended in finished_at, as a fresh agent's run does. Its outcome stays 'started'
-- while it waits: an older daemon settles only 'running' runs, and would close the agent of one as it starts up.
-- flag_reason is why the run's agent flagged the user for a look while the run went on; null for a quiet run.
ALTER TABLE clock_runs ADD COLUMN awaits_turn INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clock_runs ADD COLUMN flag_reason TEXT;

CREATE INDEX clock_runs_awaiting ON clock_runs (session_id) WHERE awaits_turn = 1 AND finished_at IS NULL;

-- Each change an agent made to its own clock, by the run it came in (null between runs): its mode ('mode', value the
-- mode it set) or a stop ('stop', value null), with the agent's reason. Kept when the clock is deleted, as its runs are.
CREATE TABLE clock_changes (
  id INTEGER PRIMARY KEY,
  clock_id TEXT NOT NULL,
  run_id INTEGER,
  at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('mode', 'stop')),
  value TEXT,
  why TEXT NOT NULL
);

CREATE INDEX clock_changes_by_clock ON clock_changes (clock_id, id);

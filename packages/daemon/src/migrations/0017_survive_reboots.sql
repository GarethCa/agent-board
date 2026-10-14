-- The board survives reboots.
-- A session whose process ended because its daemon went away (a crash, a shutdown or a reboot), not because the user
-- stopped it or it exited, is stopped by restart: the app offers to resume it. Starting the session again clears it.
ALTER TABLE sessions ADD COLUMN stopped_by_restart INTEGER NOT NULL DEFAULT 0 CHECK (stopped_by_restart IN (0, 1));
-- Where a shell session's process last was, so a resumed pane starts there. NULL until it is first seen.
ALTER TABLE sessions ADD COLUMN last_cwd TEXT;

-- The harness's own id for an agent's conversation, from its hooks' session_id, when it differs from the agent's
-- session id (Codex picks its own): what `codex resume` takes.
ALTER TABLE agents ADD COLUMN harness_session_id TEXT;

-- How the app last left the board: the viewport and its session windows. One JSON value per key.
CREATE TABLE view_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

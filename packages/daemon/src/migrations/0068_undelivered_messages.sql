-- What was sent to an agent before its session was up and never typed (`Agent.undelivered`), oldest first by id: kept
-- until the user resends or clears it, so a daemon restart still shows it with Resend.
CREATE TABLE undelivered_messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  what TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- When it was handed back: its flag says since when.
  at TEXT NOT NULL
);
CREATE INDEX undelivered_messages_session ON undelivered_messages (session_id);

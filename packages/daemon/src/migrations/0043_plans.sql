-- Plans an agent presented for the user to decide on, kept as its history: v1, v2… per agent, each with its
-- body (Markdown or HTML, as the agent sent it) and, once decided, the decision and the user's comments. A plan goes with
-- its agent. A question an agent asks (`board.ask`) is only held while it waits, so it has no table.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
  body TEXT NOT NULL,
  presented_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('approved', 'changes-requested', 'rejected', 'timed-out', 'withdrawn')),
  comments TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  UNIQUE (session_id, version)
);

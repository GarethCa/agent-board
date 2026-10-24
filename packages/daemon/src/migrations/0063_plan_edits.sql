-- The user may edit a Markdown plan the agent waits on before deciding it: the edit is a version of its own,
-- `author` 'user', and the version it was made from is stamped `edited`. `path` is the real path of the file the plan
-- was read from, if it was, which the user's approved version is written to. SQLite can't widen a CHECK in place, so
-- the table is made again with the rows it had.
CREATE TABLE plans_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
  body TEXT NOT NULL,
  presented_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('approved', 'changes-requested', 'rejected', 'timed-out', 'withdrawn', 'edited')),
  comments TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  author TEXT NOT NULL DEFAULT 'agent' CHECK (author IN ('agent', 'user')),
  path TEXT,
  UNIQUE (session_id, version)
);
INSERT INTO plans_new (id, session_id, version, title, format, body, presented_at, expires_at, outcome, comments, decided_at)
  SELECT id, session_id, version, title, format, body, presented_at, expires_at, outcome, comments, decided_at FROM plans;
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;

-- Documents an agent shows the user: a Markdown or HTML file of its, shown as a tab in its window or a card on the
-- board, and read from the file each time, so it stays live. One row per file per agent: showing it again shows the same
-- document. `version` counts the writes seen, the agent's and the user's (`written_by`); `hash` is the SHA-256 of the
-- text last seen, so a write is told from a touch. `path` is the file's real path, links resolved as it was shown;
-- `editable` says it is Markdown inside the agent's worktree, which the user may edit. A document goes with its agent.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
  title TEXT NOT NULL,
  title_given INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  written_at TEXT NOT NULL,
  written_by TEXT NOT NULL CHECK (written_by IN ('agent', 'user')),
  hash TEXT NOT NULL,
  editable INTEGER NOT NULL DEFAULT 0,
  shown_at TEXT NOT NULL,
  UNIQUE (session_id, path)
);

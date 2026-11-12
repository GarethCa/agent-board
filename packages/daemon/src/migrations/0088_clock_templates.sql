-- backward-safe: it only adds a table, which an older daemon never reads.
-- Clocks saved under a name to start new ones from, for every zone: data is the reusable part of a clock's data (its
-- cron, prompt, what it does and a fresh agent's settings), never the agent it messages. made_by is the agent that
-- saved it, null for the user's; only it, or the user, removes it.
CREATE TABLE clock_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  data TEXT NOT NULL,
  made_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

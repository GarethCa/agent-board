-- A shell tile: plain shell sessions on the board, in a zone, split into panes tmux-style. layout is the JSON tree of
-- splits whose leaves are the panes' sessions (sessions.id). The row outlives its sessions: after a daemon restart the
-- layout is still there, its panes ended, until the user closes them.
CREATE TABLE shells (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones (id),
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  layout TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

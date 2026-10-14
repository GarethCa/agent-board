-- A zone: a coloured region of the board bound to one local git repo, optionally scoped to a folder inside it.
-- Several zones may share one repo. folder is '' for a repo zone, else a '/'-separated path inside repo_root.
-- x, y, width and height are the zone's layout in board coordinates.
CREATE TABLE zones (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0),
  height REAL NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Unbound zones: a zone may be a plain group with a name and a colour, bound to no repo (repo_root NULL, so
-- folder ''), until the user binds it to one. SQLite can't drop a NOT NULL, so the table is rebuilt as it stands,
-- with the same columns in the same order (0005's tracker columns, then 0006's codex_bypass_hook_trust); migrate()
-- runs this with foreign keys off, so agents and shells keep their zone.
CREATE TABLE zones_new (
  id TEXT PRIMARY KEY,
  repo_root TEXT,
  folder TEXT NOT NULL DEFAULT '' CHECK (repo_root IS NOT NULL OR folder = ''),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0),
  height REAL NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  tracker_provider TEXT,
  tracker_scope TEXT CHECK ((tracker_provider IS NULL) = (tracker_scope IS NULL)),
  codex_bypass_hook_trust INTEGER NOT NULL DEFAULT 1 CHECK (codex_bypass_hook_trust IN (0, 1))
);
INSERT INTO zones_new (id, repo_root, folder, name, color, x, y, width, height, created_at, tracker_provider,
    tracker_scope, codex_bypass_hook_trust)
  SELECT id, repo_root, folder, name, color, x, y, width, height, created_at, tracker_provider, tracker_scope,
    codex_bypass_hook_trust
  FROM zones ORDER BY rowid;
DROP TABLE zones;
ALTER TABLE zones_new RENAME TO zones;

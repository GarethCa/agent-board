-- Shell tiles have tabs too: a shell row owned by a shell tile (owner_kind 'shell', owner_id the tile's id) is
-- one of that tile's tabs, after its first, which is the tile's own row and layout, so no pane moves. SQLite can't
-- change a CHECK, so shells is rebuilt with its columns in the same order; migrate() runs this with foreign keys off.
-- Dropping the table drops its trigger and index too, so both are made again.
CREATE TABLE shells_new (
  id TEXT PRIMARY KEY,
  zone_id TEXT REFERENCES zones (id),
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  layout TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  x REAL,
  y REAL CHECK ((x IS NULL) = (y IS NULL)),
  z REAL,
  owner_kind TEXT CHECK (owner_kind IN ('agent', 'shell')),
  owner_id TEXT CHECK ((owner_kind IS NULL) = (owner_id IS NULL))
);
INSERT INTO shells_new SELECT id, zone_id, name, cwd, layout, created_at, x, y, z, owner_kind, owner_id FROM shells ORDER BY rowid;
DROP TABLE shells;
ALTER TABLE shells_new RENAME TO shells;
CREATE INDEX shells_owner ON shells (owner_kind, owner_id);

CREATE TRIGGER connectors_leave_deleted_shell AFTER DELETE ON shells
BEGIN
  DELETE FROM connectors WHERE (from_type = 'shell' AND from_id = OLD.id) OR (to_type = 'shell' AND to_id = OLD.id);
END;

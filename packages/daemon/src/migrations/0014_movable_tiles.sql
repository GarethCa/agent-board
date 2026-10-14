-- Movable tiles: every session's tile keeps where the user put it. x and y are relative to the tile's zone,
-- so it moves with the zone, or board coordinates for a shell tile loose on the board (zone_id NULL); both NULL until
-- the tile has a place, when the board slots it in. z is its stacking order among tiles: higher draws on top.
-- SQLite can't drop a NOT NULL, so shells is rebuilt with its columns in the same order and the new ones after;
-- migrate() runs this with foreign keys off.
CREATE TABLE shells_new (
  id TEXT PRIMARY KEY,
  zone_id TEXT REFERENCES zones (id),
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  layout TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  x REAL,
  y REAL CHECK ((x IS NULL) = (y IS NULL)),
  z REAL
);
INSERT INTO shells_new (id, zone_id, name, cwd, layout, created_at)
  SELECT id, zone_id, name, cwd, layout, created_at FROM shells ORDER BY rowid;
DROP TABLE shells;
ALTER TABLE shells_new RENAME TO shells;

ALTER TABLE agents ADD COLUMN x REAL;
ALTER TABLE agents ADD COLUMN y REAL CHECK ((x IS NULL) = (y IS NULL));
ALTER TABLE agents ADD COLUMN z REAL;

-- An external session's zone is worked out from its folder whenever it is read, so its place is kept with the zone it
-- was placed in, position_zone_id, and only holds while that is still its zone.
ALTER TABLE external_sessions ADD COLUMN position_zone_id TEXT;
ALTER TABLE external_sessions ADD COLUMN x REAL;
ALTER TABLE external_sessions ADD COLUMN y REAL CHECK ((x IS NULL) = (y IS NULL));
ALTER TABLE external_sessions ADD COLUMN z REAL;

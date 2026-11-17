-- backward-safe: it only adds nullable columns and a table, which an older daemon never reads.
-- A zone's lanes area: the part of it, relative to its top-left, that its shelves or clusters are laid out in; the rest
-- of the zone is free, each tile there where it was put. All NULL for lanes that fill the zone, as every zone had.
ALTER TABLE zones ADD COLUMN lanes_x REAL;
ALTER TABLE zones ADD COLUMN lanes_y REAL;
ALTER TABLE zones ADD COLUMN lanes_width REAL;
ALTER TABLE zones ADD COLUMN lanes_height REAL;
-- The tiles the user put in a zone's free area, outside its lanes area: drawn where they were put, never laid out. Only
-- the user's own placing marks one, so a tile slotted or spawned in the zone is laid out whatever its place. A tile by
-- its key (agent:<session id>, shell:<id>); a mark counts only while its tile is in that zone.
CREATE TABLE zone_free_tiles (
  tile_key TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  placed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX zone_free_tiles_zone ON zone_free_tiles (zone_id);

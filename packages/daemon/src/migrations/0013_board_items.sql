-- A board item: a non-session object on the board, such as a sticky note. kind says which, and data (a JSON object)
-- holds what that kind needs. Inside a zone, x and y are relative to the zone, so the item moves with it; with no
-- zone they are board coordinates. z is its stacking order among items: higher draws on top.
CREATE TABLE board_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  zone_id TEXT REFERENCES zones(id),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0),
  height REAL NOT NULL CHECK (height > 0),
  z REAL NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Removing a zone leaves its items on the board where they were.
CREATE TRIGGER board_items_leave_removed_zone BEFORE DELETE ON zones
BEGIN
  UPDATE board_items
  SET zone_id = NULL, x = x + OLD.x, y = y + OLD.y, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE zone_id = OLD.id;
END;

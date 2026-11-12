-- backward-safe: it only adds a column with a default and a table, which an older daemon never reads.
-- A zone's layout rule: off (as every zone always was) or a rule the daemon lays the zone out by again whenever its work
-- changes. Lanes (a lane per ticket) is the first; status and spine are allowed for the rules that follow. Every existing
-- zone stays off; nothing moves on upgrade.
ALTER TABLE zones ADD COLUMN layout_rule TEXT NOT NULL DEFAULT 'off' CHECK (layout_rule IN ('off', 'lanes', 'status', 'spine'));
-- The tiles the user placed by hand in a zone with a rule: the rule skips them, leaving each where it was put, until it
-- is put back under the rule. A tile by its key (agent:<session id>, shell:<id> or item:<id>); a mark counts only while
-- its tile is in that zone.
CREATE TABLE zone_hand_placed (
  tile_key TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  placed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX zone_hand_placed_zone ON zone_hand_placed (zone_id);

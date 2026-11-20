-- backward-safe: it only adds a column with a default, which an older daemon never reads.
-- Where an arrange in the zone places each kind of its items (`Zone.placements`): a JSON object of kind to placement
-- (cluster, sidebar, top or stay), only the kinds chosen; a kind not in it takes the default.
ALTER TABLE zones ADD COLUMN placements TEXT NOT NULL DEFAULT '{}';

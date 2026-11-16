-- backward-safe: it only adds a nullable column, which an older daemon never reads.
-- Where each agent of a saved prefab sits on its board, as JSON by agent id; NULL for a prefab laid out from its lines.
-- Kept beside the prefab's file, never in it, so the file reads in an older app as before.
ALTER TABLE crew_prefabs ADD COLUMN places TEXT;

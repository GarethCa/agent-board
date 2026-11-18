-- backward-safe: it only adds a column with a default, which an older daemon never reads; it runs a crew by its round columns, which this one keeps in step with its first loop gate.
-- Where a running crew is in its prefab's graph, as JSON: the live agent of each member and since when its hand-off
-- counts, each loop gate's round, limit and the words its deciders gave, the deliveries a wait-for-all member holds,
-- what waits at Your OK, and the deliveries not yet made. '{}' for a crew from before, read from its round columns.
ALTER TABLE crews ADD COLUMN run TEXT NOT NULL DEFAULT '{}';

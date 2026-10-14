-- Unsorted is a normal group zone, made on demand for external sessions that no zone holds. This marks the
-- one such sessions go to, so renaming it doesn't lose it; it is set by the daemon, never by a client. The group
-- itself is made by the daemon, at startup for boards that already show sessions in the old fixed "Unsorted" area,
-- and then whenever a session has no zone and no marked group is unbound.
ALTER TABLE zones ADD COLUMN unsorted INTEGER NOT NULL DEFAULT 0 CHECK (unsorted IN (0, 1));

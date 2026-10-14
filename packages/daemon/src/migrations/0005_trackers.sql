-- Trackers. A zone may pick an issue tracker and a scope in it (a Linear team key). An agent may be linked to
-- one issue: its provider and ID, with the title and URL as they were when linked, so tiles show them without asking
-- the tracker. Tracker credentials live in the OS keychain, never here. Providers are checked by the daemon (the list in
-- @agent-board/tracker), not here, so adding one needs no migration.
ALTER TABLE zones ADD COLUMN tracker_provider TEXT;
ALTER TABLE zones ADD COLUMN tracker_scope TEXT CHECK ((tracker_provider IS NULL) = (tracker_scope IS NULL));
ALTER TABLE agents ADD COLUMN issue_provider TEXT;
ALTER TABLE agents ADD COLUMN issue_id TEXT;
ALTER TABLE agents ADD COLUMN issue_title TEXT;
ALTER TABLE agents ADD COLUMN issue_url TEXT;

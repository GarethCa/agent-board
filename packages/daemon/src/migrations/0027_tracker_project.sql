-- Linear project zones: a zone's tracker can be narrowed to one project of its team, so its issue picker lists
-- only that project's issues. The project's ID (not its name, which can change); NULL for the whole scope.
ALTER TABLE zones ADD COLUMN tracker_project TEXT;

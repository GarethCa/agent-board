-- A group may run its agents with no repo in a folder of the user's, outside git, rather than the one the app makes for
-- it in its data directory: null for the app's. An agent that runs in such a folder is marked as one, as its path no
-- longer says so; the agents there already are in the app's own group folders, which are still known by their path.
ALTER TABLE zones ADD COLUMN group_folder TEXT;
ALTER TABLE agents ADD COLUMN plain_folder INTEGER NOT NULL DEFAULT 0;

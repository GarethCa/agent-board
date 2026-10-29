-- Whether the zone's folder (and the worktrees made under it) is trusted for its new Claude agents: when one shows
-- Claude's trust screen the daemon answers it, as the user's click on Trust folder would. Off for every zone there is;
-- the user turns it on when adding a zone or from its menu. An agent records that its zone's setting answered for it,
-- so its tile keeps saying so.
ALTER TABLE zones ADD COLUMN trusts_folder INTEGER NOT NULL DEFAULT 0 CHECK (trusts_folder IN (0, 1));
ALTER TABLE agents ADD COLUMN trusted_by_zone INTEGER NOT NULL DEFAULT 0 CHECK (trusted_by_zone IN (0, 1));

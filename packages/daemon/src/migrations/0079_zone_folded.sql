-- Whether a zone is folded to a chip while it is not needed. Its place and size stay as they were, so unfolding puts it
-- back exactly. Every existing zone stays unfolded; nothing moves or pauses on upgrade.
ALTER TABLE zones ADD COLUMN folded INTEGER NOT NULL DEFAULT 0 CHECK (folded IN (0, 1));

-- The zone whose fold paused the agent, while it stays paused: what unfolding and waking that zone wakes. NULL for one
-- paused any other way, and once it wakes, is closed, or its zone unfolds.
ALTER TABLE agents ADD COLUMN hibernated_fold TEXT;

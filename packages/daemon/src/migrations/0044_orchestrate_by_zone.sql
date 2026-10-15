-- An agent orchestrates while its current zone's switch is on, however it came to be there (the governance
-- review's G9): the zone that once granted it no longer matters. `orchestrate` is now a scope the user set by hand, or
-- NULL to follow the zone; `orchestrate_off` is 1 once the user turned the agent off, which no zone overrides until the
-- user turns it on again. The zones' grants recorded before are dropped: each such agent follows its zone now.
ALTER TABLE agents ADD COLUMN orchestrate_off INTEGER NOT NULL DEFAULT 0 CHECK (orchestrate_off IN (0, 1));
UPDATE agents SET orchestrate = NULL WHERE orchestrate_zone IS NOT NULL;
ALTER TABLE agents DROP COLUMN orchestrate_zone;

-- How deep in a crew each agent was started (0 for the user's), kept on the agent: deleting one above it nulls its
-- `spawned_by`, but never lowers its depth, so the depth cap holds. The agents there were count up their chain now; one
-- deeper than the cap, or in a broken chain, counts as at the cap.
ALTER TABLE agents ADD COLUMN crew_depth INTEGER NOT NULL DEFAULT 0;
WITH RECURSIVE chain(session_id, depth) AS (
  SELECT session_id, 0 FROM agents WHERE spawned_by IS NULL
  UNION ALL
  SELECT agents.session_id, chain.depth + 1 FROM agents JOIN chain ON agents.spawned_by = chain.session_id WHERE chain.depth < 3
)
UPDATE agents SET crew_depth = COALESCE((SELECT max(depth) FROM chain WHERE chain.session_id = agents.session_id), 3);

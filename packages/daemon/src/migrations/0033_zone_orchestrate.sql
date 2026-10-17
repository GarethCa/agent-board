-- Whether the agents the user starts in a zone may orchestrate there. On by default, for the zones there
-- are too; the user turns it off per zone. Agents already on the board are left as they are: only the agents started in
-- a zone that allows it get it. `orchestrate_zone` is the zone that let an agent orchestrate, NULL when the user did so
-- by hand: the zone's grant holds only while the agent's tile is in that zone and the zone still allows it.
ALTER TABLE zones ADD COLUMN agents_orchestrate INTEGER NOT NULL DEFAULT 1 CHECK (agents_orchestrate IN (0, 1));
ALTER TABLE agents ADD COLUMN orchestrate_zone TEXT;

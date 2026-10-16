-- Orchestrators lay out their zone (agent-board move, arrange, zone, note): the groups and notes an agent made are
-- marked with its session id, as flow_edges.made_by is (0038), so it edits and removes only those. NULL for the user's,
-- and for one made again by an undo. No foreign key: it still says an agent made it once that agent is deleted, and then
-- no orchestrator edits it (none is in that agent's crew any more), only the user's side.
ALTER TABLE zones ADD COLUMN made_by TEXT;
ALTER TABLE board_items ADD COLUMN made_by TEXT;

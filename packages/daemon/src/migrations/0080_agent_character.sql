-- The pose an agent set for its character (`Agent.character`): its pose, with a face and a prop of its own if it
-- gave them, when it set them, and the orchestrator's name when it set them for its crew (NULL when the agent did).
-- All NULL while it has none, when the board draws its own pose.
ALTER TABLE agents ADD COLUMN character_pose TEXT;
ALTER TABLE agents ADD COLUMN character_face TEXT;
ALTER TABLE agents ADD COLUMN character_prop TEXT;
ALTER TABLE agents ADD COLUMN character_set_at TEXT;
ALTER TABLE agents ADD COLUMN character_set_by TEXT;

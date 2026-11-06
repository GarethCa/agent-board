-- Whether an agent's current conversation has had a turn of its own (a fresh restart starts a new one and resets it). A resume that finds no conversation to carry on says so only for an agent
-- that had one; an agent that never had a turn has nothing to lose, so its resume says nothing.
ALTER TABLE agents ADD COLUMN had_turn INTEGER NOT NULL DEFAULT 0;
UPDATE agents SET had_turn = 1 WHERE finished_at IS NOT NULL;
-- Approximate for agents already stored: one that had a fresh restart before this may count as having had a turn.

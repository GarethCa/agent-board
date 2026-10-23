-- The board master (ADR-0019): the one agent the user asks for work. At most one agent is it.
ALTER TABLE agents ADD COLUMN master INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX agents_one_master ON agents (master) WHERE master = 1;

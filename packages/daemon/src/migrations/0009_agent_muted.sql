-- 1 when the user muted the agent's OS notifications. It still counts in the inbox and the badge.
ALTER TABLE agents ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;

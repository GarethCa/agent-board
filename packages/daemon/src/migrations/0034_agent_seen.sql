-- 1 when the user has opened the agent's session since it began its current ask (waiting or a permission prompt). It
-- stops counting as needing the user until its state changes.
ALTER TABLE agents ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;

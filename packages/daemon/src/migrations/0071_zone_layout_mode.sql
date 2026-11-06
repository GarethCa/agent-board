-- How a zone lays out what it holds: free (each tile where it was put, as every zone always was) or shelves (its work
-- drawn as stacks on To do, Doing, Waiting and Done shelves). Clusters (each unit of work a loose group of its tiles) is
-- allowed for the layout that follows. Every existing zone stays free; nothing moves on upgrade.
ALTER TABLE zones ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'free' CHECK (layout_mode IN ('free', 'shelves', 'clusters'));

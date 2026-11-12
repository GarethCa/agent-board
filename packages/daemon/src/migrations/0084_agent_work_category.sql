-- backward-safe: new nullable columns, which an older daemon never reads or writes.
-- The work category an agent set (`Agent.workCategory`, ADR-0024): one of the seven, its own label for it, who it waits
-- on and their reference, when it was set, and the orchestrator's name when it set it for its crew (NULL when the agent
-- did). All NULL while it has none, when the board guesses one.
ALTER TABLE agents ADD COLUMN work_category TEXT
  CHECK (work_category IS NULL OR work_category IN ('needs-help', 'ready-for-review', 'blocked', 'waiting-on-others', 'in-review', 'working', 'done'));
ALTER TABLE agents ADD COLUMN work_category_label TEXT;
ALTER TABLE agents ADD COLUMN waiting_on_who TEXT;
ALTER TABLE agents ADD COLUMN waiting_on_ref TEXT;
ALTER TABLE agents ADD COLUMN work_category_set_at TEXT;
ALTER TABLE agents ADD COLUMN work_category_set_by TEXT;

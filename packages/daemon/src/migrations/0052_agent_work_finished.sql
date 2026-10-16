-- An agent says its work is finished: it hands off, or sets its status as done. A turn ending is not
-- finishing, since an agent may end turns while its background work runs. NULL until then, and again from its next
-- prompt.
ALTER TABLE agents ADD COLUMN work_finished_at TEXT;

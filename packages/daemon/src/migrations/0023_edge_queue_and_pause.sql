-- Edge rules as FlowRules draws them: an edge may be paused, and may deliver to an agent that can't take it
-- now by queueing it until that agent's turn ends (`deliver_as` 'queue'): the queued payload, its name, and since when.
ALTER TABLE flow_edges ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_edges ADD COLUMN deliver_as TEXT NOT NULL DEFAULT 'message';
ALTER TABLE flow_edges ADD COLUMN queued_name TEXT;
ALTER TABLE flow_edges ADD COLUMN queued_text TEXT;
ALTER TABLE flow_edges ADD COLUMN queued_since TEXT;

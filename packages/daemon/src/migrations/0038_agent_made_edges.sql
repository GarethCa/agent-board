-- Edges an orchestrator makes: `made_by` is the agent that made the edge through the board CLI or MCP, NULL for
-- one the user drew. It is no foreign key: the edge says an agent made it after that agent is deleted, and the activity
-- log keeps its name.
ALTER TABLE flow_edges ADD COLUMN made_by TEXT;

-- What an agent says it is doing now, set from its own session with `agent-board status set`: a short
-- summary, an optional percentage, and when it was set. NULL until it sets one, when its tile shows its task.
ALTER TABLE agents ADD COLUMN status_summary TEXT;
ALTER TABLE agents ADD COLUMN status_progress INTEGER CHECK (status_progress BETWEEN 0 AND 100);
ALTER TABLE agents ADD COLUMN status_updated_at TEXT;
-- Whether agents started from the zone get the board MCP server. On by default.
ALTER TABLE zones ADD COLUMN board_mcp INTEGER NOT NULL DEFAULT 1 CHECK (board_mcp IN (0, 1));

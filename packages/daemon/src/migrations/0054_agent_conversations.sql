-- The conversations an agent had before a fresh restart (`restart --fresh`) started a new one in its tile: the id its
-- harness knew the conversation by and where its transcript was, so the old one stays reachable. Newest last.
CREATE TABLE agent_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  harness_session_id TEXT NOT NULL,
  transcript_path TEXT,
  ended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX agent_conversations_session ON agent_conversations (session_id);

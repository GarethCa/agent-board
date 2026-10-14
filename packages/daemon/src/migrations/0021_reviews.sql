-- Review rounds. A reviewer is an agent spawned to review another, its implementer: `review_of` names the
-- implementer. An implementer's reviews come in numbered rounds, at most `review_cap` of them (NULL for the default).
-- Each round keeps its reviewer while it has one, the doc it left (its final message), or why it left none, and when
-- the doc was sent to the implementer or the round dismissed, and `head`, the commit its reviewer reviewed: only that
-- commit may be merged on the round's approval. Rounds go with their implementer. An agent's `base_commit` is the
-- commit its branch started from, which its work is reviewed against (NULL for agents from before).
ALTER TABLE agents ADD COLUMN review_of TEXT REFERENCES agents (session_id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN review_cap INTEGER;
ALTER TABLE agents ADD COLUMN base_commit TEXT;
CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY,
  implementer_session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  reviewer_session_id TEXT REFERENCES agents (session_id) ON DELETE SET NULL,
  head TEXT,
  doc TEXT,
  failed_because TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  sent_at TEXT,
  dismissed_at TEXT,
  UNIQUE (implementer_session_id, round)
);
CREATE INDEX review_rounds_reviewer ON review_rounds (reviewer_session_id);

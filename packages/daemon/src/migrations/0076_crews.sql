-- A running crew, started from a crew prefab whose reviewers start at its builder's hand-off: the prefab as it was
-- started (its file's text), the round it is on, and why it stopped. Its builder, and the reviewers each round
-- started, are its members. None of these point at `agents` with a key: a crew outlives an agent the user deletes,
-- and says so.
CREATE TABLE crews (
  id TEXT NOT NULL PRIMARY KEY,
  prefab TEXT NOT NULL,
  body TEXT NOT NULL,
  zone_id TEXT,
  -- The orchestrator that started it, whose crew its members join; null for the user.
  started_by TEXT,
  builder TEXT NOT NULL,
  prompt TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  round_limit INTEGER NOT NULL,
  -- 'building' until the builder hands off, 'reviewing' until the round's reviewers have each left a review.
  phase TEXT NOT NULL DEFAULT 'building',
  phase_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- 1 while its round's reviewers failed to start: `crew round` starts them again.
  start_failed INTEGER NOT NULL DEFAULT 0,
  stopped TEXT,
  stopped_at TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE crew_reviewers (
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  member TEXT NOT NULL,
  round INTEGER NOT NULL,
  -- Its review, once it left one: its verdict ('approve' or 'changes-requested'), what it said, and how many blockers it left open.
  verdict TEXT,
  review TEXT,
  blockers INTEGER,
  PRIMARY KEY (crew_id, session_id)
);

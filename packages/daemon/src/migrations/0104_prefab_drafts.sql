-- backward-safe: it only adds tables, which an older daemon never reads.
-- Crew prefabs agents drafted for the user, kept until the user opens and saves or deletes them, with no expiry. The
-- body is the draft's `.crew.json` text, read with the file's own strict parser as a library row is; its assumptions
-- are JSON, a line each and what it is about. The drafter is named as it was, its tile kept without a key: a draft
-- outlives its drafter.
CREATE TABLE prefab_drafts (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  assumptions TEXT NOT NULL DEFAULT '[]',
  drafter_tile TEXT NOT NULL,
  drafter_name TEXT NOT NULL,
  closes_drafter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The agents started only to draft a prefab: each closes once its draft is opened.
CREATE TABLE prefab_drafters (
  session_id TEXT PRIMARY KEY
);

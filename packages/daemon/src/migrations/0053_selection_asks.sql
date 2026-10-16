-- Ask Claude about a selection: one row per agent started to answer one, until the agent goes. `ask` is its JSON:
-- what was asked, the board objects the selection's diagram names, where the answer note and the tile go, and the
-- folder its picture and diagram are in. `note_id` is the answer's agent note once its first turn has finished.
CREATE TABLE selection_asks (
  session_id TEXT NOT NULL PRIMARY KEY,
  ask TEXT NOT NULL,
  note_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An agent started in a folder it doesn't own with nothing to change there, such as an Ask Claude agent reading the
-- user's checkout: Claude starts in plan mode and Codex in its read-only sandbox, on every launch. 0 for any other.
ALTER TABLE agents ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;

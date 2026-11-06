-- A memory's entries and a queue's jobs, beside the board item that is the object itself (kind `memory` or `queue`),
-- as an item's data is too small to hold them. An entry is keyed (a key's value is replaced, not piled up), a keyless
-- note, or a file kept whole. A job is taken, dropped back and done; a queue holds plain notes too. Every change to
-- either is a row of board_history, so a change can be taken back.
--
-- Neither table holds a foreign key to board_items: undoing an item's delete makes it again with the same id, and its
-- rows are there for it. The daemon sweeps rows whose item is gone as it starts.
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  key TEXT,
  is_file INTEGER NOT NULL DEFAULT 0 CHECK (is_file IN (0, 1)),
  text TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  made_by TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (is_file = 0 OR key IS NOT NULL)
);
CREATE INDEX memory_entries_item ON memory_entries (item_id);
CREATE UNIQUE INDEX memory_entries_key ON memory_entries (item_id, key) WHERE key IS NOT NULL;

CREATE TABLE queue_jobs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('job', 'note')),
  text TEXT NOT NULL,
  link TEXT,
  position REAL NOT NULL,
  taken_by TEXT,
  taken_at TEXT,
  drops INTEGER NOT NULL DEFAULT 0,
  done_by TEXT,
  done_at TEXT,
  made_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX queue_jobs_item ON queue_jobs (item_id, position);
CREATE INDEX queue_jobs_taker ON queue_jobs (taken_by) WHERE taken_by IS NOT NULL;

-- One row a change: `value` is the entry or job as the change left it (JSON), null once removed.
CREATE TABLE board_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  action TEXT NOT NULL,
  value TEXT,
  by TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX board_history_row ON board_history (item_id, row_id, seq);

-- Removing a zone still leaves its items on the board where they were, but a memory or queue it held turns to No
-- agents: loose, it would otherwise widen to every agent on the board. The user chooses its scope from there.
DROP TRIGGER board_items_leave_removed_zone;
CREATE TRIGGER board_items_leave_removed_zone BEFORE DELETE ON zones
BEGIN
  UPDATE board_items
  SET zone_id = NULL, x = x + OLD.x, y = y + OLD.y, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    data = CASE WHEN kind IN ('memory', 'queue') THEN json_set(data, '$.noAgents', json('true')) ELSE data END
  WHERE zone_id = OLD.id;
END;

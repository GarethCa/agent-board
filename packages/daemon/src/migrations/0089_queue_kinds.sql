-- not backward-safe: it renames every queue row's kind, which an older daemon reads as neither a job nor a note.
-- A queue's rows get kinds by who the queue is for. An agents' queue holds tasks, requests and prompts, which an agent
-- takes and finishes, and info, which it reads and never takes. The user's queue holds reviews, questions, backlog and
-- things to read, each of which the user finishes. A job becomes a task (backlog on the user's queue) and a note becomes
-- info (something to read on the user's queue), in the rows and in their history alike. `result` is what its finisher
-- said was done; `hidden_until` is when a row the user put off for later comes back. SQLite can't widen a CHECK in
-- place, so the table is made again with the rows it had.
CREATE TABLE queue_jobs_new (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'info', 'request', 'prompt', 'review', 'questions', 'backlog', 'read')),
  text TEXT NOT NULL,
  link TEXT,
  position REAL NOT NULL,
  taken_by TEXT,
  taken_at TEXT,
  drops INTEGER NOT NULL DEFAULT 0,
  done_by TEXT,
  done_at TEXT,
  result TEXT,
  hidden_until TEXT,
  made_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO queue_jobs_new (id, item_id, kind, text, link, position, taken_by, taken_at, drops, done_by, done_at, made_by, created_at, updated_at)
  SELECT j.id, j.item_id,
    CASE WHEN json_extract(i.data, '$.audience') = 'user'
      THEN CASE j.kind WHEN 'note' THEN 'read' ELSE 'backlog' END
      ELSE CASE j.kind WHEN 'note' THEN 'info' ELSE 'task' END
    END,
    j.text, j.link, j.position, j.taken_by, j.taken_at, j.drops, j.done_by, j.done_at, j.made_by, j.created_at, j.updated_at
  FROM queue_jobs j LEFT JOIN board_items i ON i.id = j.item_id;
DROP TABLE queue_jobs;
ALTER TABLE queue_jobs_new RENAME TO queue_jobs;
CREATE INDEX queue_jobs_item ON queue_jobs (item_id, position);
CREATE INDEX queue_jobs_taker ON queue_jobs (taken_by) WHERE taken_by IS NOT NULL;

-- A queue row's past versions, so a restore puts back a kind the table now takes.
UPDATE board_history
SET value = json_set(value, '$.kind',
  CASE WHEN (SELECT json_extract(i.data, '$.audience') FROM board_items i WHERE i.id = board_history.item_id) = 'user'
    THEN CASE json_extract(value, '$.kind') WHEN 'note' THEN 'read' ELSE 'backlog' END
    ELSE CASE json_extract(value, '$.kind') WHEN 'note' THEN 'info' ELSE 'task' END
  END)
WHERE value IS NOT NULL
  AND json_extract(value, '$.kind') IN ('job', 'note')
  AND item_id IN (SELECT id FROM board_items WHERE kind = 'queue');

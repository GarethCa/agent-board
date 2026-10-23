-- What an agent records about its own work, for its sidebar: a pull request it opened (`pr`, keyed by `owner/repo#n` in lower case),
-- a hand-off doc (`doc`, keyed by its real path) and an agent it started (`crew`, keyed by that agent's session).
-- `data` is the record as JSON. `deleted_at` is set once the user deletes it from the sidebar: the row stays, so the
-- same entry guessed from gh or hooks stays hidden too, until the agent records it again.
--
-- Backward-safe: it only adds this table, and nothing else reads or references it. To go back to schema 55 by hand,
-- `DROP TABLE agent_records; PRAGMA user_version = 55;` loses only the records.
CREATE TABLE agent_records (
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  PRIMARY KEY (session_id, kind, key)
);

-- The agents each orchestrator started before records were kept are its crew records.
INSERT INTO agent_records (session_id, kind, key, data, recorded_at)
SELECT a.spawned_by, 'crew', a.session_id, '{}', s.created_at FROM agents a JOIN sessions s ON s.id = a.session_id
WHERE a.spawned_by IN (SELECT session_id FROM agents)
ORDER BY a.rowid;

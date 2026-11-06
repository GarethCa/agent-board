-- The app's crew prefab library: one for every board, beside the built-ins (which live in the code, not here). A
-- prefab's body is its `.crew.json` file's text, checked by the daemon on every write. One per name, in any case.
CREATE TABLE crew_prefabs (
  name TEXT NOT NULL COLLATE NOCASE PRIMARY KEY,
  body TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

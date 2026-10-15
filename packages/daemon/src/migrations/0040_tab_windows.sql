-- Tab windows (slice 4): a pull request or web tab dragged out of a session window on its own pops out into
-- an OS window that is no session's, kept here as owner_kind 'tabs' with an id of its own. SQLite can't widen a CHECK
-- in place, so the table is made again with the rows it had, and the trigger that keeps it with its shell tiles.
DROP TRIGGER window_layouts_leave_deleted_shell;
CREATE TABLE window_layouts_new (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('agent', 'shell', 'tabs')),
  owner_id TEXT NOT NULL,
  layout TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
INSERT INTO window_layouts_new (owner_kind, owner_id, layout) SELECT owner_kind, owner_id, layout FROM window_layouts;
DROP TABLE window_layouts;
ALTER TABLE window_layouts_new RENAME TO window_layouts;

CREATE TRIGGER window_layouts_leave_deleted_shell AFTER DELETE ON shells
BEGIN
  DELETE FROM window_layouts WHERE owner_kind = 'shell' AND owner_id = OLD.id;
END;

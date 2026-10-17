-- A session window's panes: how its tabs are laid out, as panes with a strip each, kept per owner (an
-- agent's session id, or a shell tile's id) as WindowLayout JSON. Tabs themselves stay rows of shells; this keeps only
-- where each shows. An owner with no row shows one pane holding its strip as it was, so nothing needs migrating.
CREATE TABLE window_layouts (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('agent', 'shell')),
  owner_id TEXT NOT NULL,
  layout TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

-- A shell tile's layout goes with its row however the row goes (deleted, or its last pane closed), as its connectors do.
CREATE TRIGGER window_layouts_leave_deleted_shell AFTER DELETE ON shells
BEGIN
  DELETE FROM window_layouts WHERE owner_kind = 'shell' AND owner_id = OLD.id;
END;

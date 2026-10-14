-- A connector: an annotation arrow or line between two board objects. Each end names its object by type and
-- id, the object's own id in its own table, so SQLite can't hold it as a foreign key; the triggers below delete a
-- connector with either object instead, so no code path that removes one can leave a connector dangling. An external
-- session is only hidden when dismissed (its row stays), so its connectors do too.
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_side TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_side TEXT NOT NULL,
  style TEXT NOT NULL,
  start_end TEXT NOT NULL,
  end_end TEXT NOT NULL,
  color TEXT,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX connectors_from ON connectors (from_type, from_id);
CREATE INDEX connectors_to ON connectors (to_type, to_id);

CREATE TRIGGER connectors_leave_deleted_item AFTER DELETE ON board_items
BEGIN
  DELETE FROM connectors WHERE (from_type = 'item' AND from_id = OLD.id) OR (to_type = 'item' AND to_id = OLD.id);
END;

CREATE TRIGGER connectors_leave_deleted_zone AFTER DELETE ON zones
BEGIN
  DELETE FROM connectors WHERE (from_type = 'zone' AND from_id = OLD.id) OR (to_type = 'zone' AND to_id = OLD.id);
END;

CREATE TRIGGER connectors_leave_deleted_agent AFTER DELETE ON agents
BEGIN
  DELETE FROM connectors WHERE (from_type = 'agent' AND from_id = OLD.session_id) OR (to_type = 'agent' AND to_id = OLD.session_id);
END;

CREATE TRIGGER connectors_leave_deleted_shell AFTER DELETE ON shells
BEGIN
  DELETE FROM connectors WHERE (from_type = 'shell' AND from_id = OLD.id) OR (to_type = 'shell' AND to_id = OLD.id);
END;

CREATE TRIGGER connectors_leave_deleted_external AFTER DELETE ON external_sessions
BEGIN
  DELETE FROM connectors WHERE (from_type = 'external' AND from_id = OLD.id) OR (to_type = 'external' AND to_id = OLD.id);
END;

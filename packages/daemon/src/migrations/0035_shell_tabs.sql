-- Shells as tabs of a session window: a shell row owned by an agent is one of the tabs in the agent's window,
-- not a tile on the board, so it has no zone or place (zone_id, x, y and z stay NULL). owner_kind says what owns it
-- ('agent' for now) and owner_id which one: the agent's session id. The agent's own tab is such a row too, its layout's
-- first pane the agent's session. Moving a tab to another owner later changes only these two columns.
ALTER TABLE shells ADD COLUMN owner_kind TEXT CHECK (owner_kind IN ('agent'));
ALTER TABLE shells ADD COLUMN owner_id TEXT CHECK ((owner_kind IS NULL) = (owner_id IS NULL));
CREATE INDEX shells_owner ON shells (owner_kind, owner_id);

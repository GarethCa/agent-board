-- Agents draw diagrams (agent-board connect): a connector an agent made is marked with its session id, as a board item's
-- made_by is (0048), so it edits and removes only those. NULL for the user's, and for one made again by an undo.
--
-- Backward-safe: it only adds a nullable column, which an older daemon never names. To go back to schema 61 by hand,
-- `PRAGMA user_version = 61;` is enough: the column stays, unread.
ALTER TABLE connectors ADD COLUMN made_by TEXT;

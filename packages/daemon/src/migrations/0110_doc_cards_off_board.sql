-- backward-safe: it only deletes board items, which an older daemon reads as cards taken off the board.
-- A document or plan an agent shows is listed with it, not put on the board (Settings' placeDocTiles, off by default):
-- the document and plan cards placed before go, once, with the connectors drawn to them (their trigger). The documents
-- and plans stay their agents'.
DELETE FROM board_items WHERE kind IN ('document', 'plan');

-- backward-safe: it only adds two nullable columns, which an older daemon never reads.
-- An agent's place on its ticket's own board: a helper's on its ticket's, a ticket chat's on its own. Board
-- coordinates on that board, apart from x and y, the tile's place on the main board; both NULL until it is placed there.
ALTER TABLE agents ADD COLUMN ticket_x REAL;
ALTER TABLE agents ADD COLUMN ticket_y REAL CHECK ((ticket_x IS NULL) = (ticket_y IS NULL));

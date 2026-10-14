-- An item's angle on the board, in degrees clockwise about its own centre: set only by the user's Rotate tool,
-- so every item starts straight. x, y, width and height stay the unrotated box's.
ALTER TABLE board_items ADD COLUMN rotation REAL NOT NULL DEFAULT 0;

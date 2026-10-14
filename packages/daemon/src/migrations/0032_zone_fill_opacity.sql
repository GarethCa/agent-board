-- A zone's fill opacity in percent: set by the user's slider, 0 (outline only) to 40. NULL for the theme's own
-- (8% light, 6% dark), which every zone starts with, so existing zones look as they did.
ALTER TABLE zones ADD COLUMN fill_opacity INTEGER CHECK (fill_opacity BETWEEN 0 AND 40);

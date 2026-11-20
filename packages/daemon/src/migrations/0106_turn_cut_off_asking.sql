-- backward-safe: it only adds a column with a default, which an older daemon never reads.
-- Of an agent whose turn was cut off (turn_cut_off), whether it was on a permission prompt, asking rather than working:
-- Wake all after a restart leaves it asleep. Set and cleared with turn_cut_off.
ALTER TABLE agents ADD COLUMN turn_cut_off_asking INTEGER NOT NULL DEFAULT 0 CHECK (turn_cut_off_asking IN (0, 1));

-- An agent whose daemon went away under it while it was at work (running, thinking or on a permission prompt): its
-- turn was cut off, so resuming it types a line telling it to carry on. Set as its session ends with the daemon, or
-- found at start for a daemon that died; cleared once it is started again.
ALTER TABLE agents ADD COLUMN turn_cut_off INTEGER NOT NULL DEFAULT 0 CHECK (turn_cut_off IN (0, 1));

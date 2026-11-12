-- backward-safe: it only adds a column with a default to clock_runs, which an older daemon never reads.
-- joins is 1 for a run that starts its clock's own agent (an unjoined clock that starts one, startsAgent) and joins it:
-- the run settles as a message's does, kept by the run itself, so its agent is never closed after it as a fresh one is.
ALTER TABLE clock_runs ADD COLUMN joins INTEGER NOT NULL DEFAULT 0;

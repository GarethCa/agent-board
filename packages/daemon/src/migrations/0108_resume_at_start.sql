-- backward-safe: it only adds a column with a default, which an older daemon never reads.
-- Of a session stopped by restart (stopped_by_restart), whether the restart that stopped it is the latest: set with that
-- mark as the daemon shuts down or finds sessions a dead daemon left live, and cleared once the next daemon's start has
-- brought it back (or tried to), or as it is started again any other way. A session left stopped by an earlier restart
-- has it cleared, so a later start never wakes it.
-- An older daemon neither sets nor clears it: after one ran on this database, a start can wake the sessions of an
-- earlier restart in place of its own.
ALTER TABLE sessions ADD COLUMN resume_at_start INTEGER NOT NULL DEFAULT 0 CHECK (resume_at_start IN (0, 1));
-- The daemon that shut down before this one set no marks. The sessions it stopped as it shut down are the latest
-- batch stopped by restart (ended within a minute of its last), so long as no session started after it: one that did
-- means the board ran since, and that batch is an earlier restart's. A shutdown that took over a minute to end its
-- sessions leaves its first few unmarked: they stay stopped by restart, each with its own Wake.
UPDATE sessions SET resume_at_start = 1
WHERE stopped_by_restart = 1
  AND julianday(ended_at) >= (SELECT julianday(MAX(ended_at)) FROM sessions WHERE stopped_by_restart = 1) - 60.0 / 86400
  AND NOT EXISTS (
    SELECT 1 FROM sessions AS later
    WHERE julianday(later.created_at) > (SELECT julianday(MAX(ended_at)) FROM sessions WHERE stopped_by_restart = 1)
  );

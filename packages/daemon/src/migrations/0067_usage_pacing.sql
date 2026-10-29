-- Usage pacing. The newest plan usage reading a Claude agent's status line posted: one row, replaced by each newer
-- reading, so a restart shows the last one (stale by then) rather than none. Each window's used percentage and when it
-- resets (epoch seconds), NULL for a window the reading didn't carry.
CREATE TABLE usage_reading (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  five_hour_used REAL,
  five_hour_resets_at INTEGER,
  seven_day_used REAL,
  seven_day_resets_at INTEGER,
  read_at TEXT NOT NULL
);
-- The user's priority for each zone, which the usage thresholds speak in; every zone is normal until the user says.
ALTER TABLE zones ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low'));
-- A budget hold on the zone: why, and since when. Both NULL while it is not held.
ALTER TABLE zones ADD COLUMN usage_hold_reason TEXT;
ALTER TABLE zones ADD COLUMN usage_hold_at TEXT;
-- Why a paused agent was paused, when it was paused for usage; NULL otherwise.
ALTER TABLE agents ADD COLUMN hibernated_reason TEXT;

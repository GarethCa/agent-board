-- Schedules are clocks: board items of kind 'clock' whose data holds the schedule (ClockData in protocol.ts). A clock
-- either messages the agent it is joined to or starts a fresh agent for each run. Each time one fires is a row of
-- clock_runs: due_at is the fire time it was due at, fired_at when it went off (later if the machine slept through it),
-- outcome how it went (reason says why it skipped or failed), session_id and agent_name the agent it messaged or
-- started, and for a fresh agent finished_at and result (its final message) once its run is over. A clock's runs stay
-- when it is deleted, so undoing the delete brings its history back.
CREATE TABLE clock_runs (
  id INTEGER PRIMARY KEY,
  clock_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'skipped', 'running', 'done', 'failed')),
  reason TEXT,
  session_id TEXT,
  agent_name TEXT,
  finished_at TEXT,
  result TEXT
);

CREATE INDEX clock_runs_by_clock ON clock_runs (clock_id, id);
CREATE INDEX clock_runs_by_session ON clock_runs (session_id) WHERE session_id IS NOT NULL;

-- Each agent's schedule becomes a clock beside its tile, in its zone, joined to it: on its left when there is room in
-- the zone (always, for a tile loose on the board), else on its right. Its runs move with it.
INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data)
SELECT
  'clock-' || s.session_id,
  'clock',
  a.zone_id,
  CASE WHEN a.zone_id IS NULL OR coalesce(a.x, 0) >= 332 THEN coalesce(a.x, 0) - 316 ELSE coalesce(a.x, 0) + 316 END,
  coalesce(a.y, 0),
  256,
  76,
  (SELECT coalesce(max(z), 0) FROM board_items) + row_number() OVER (ORDER BY s.created_at, s.rowid),
  json_object(
    'cron', s.cron,
    'enabled', json(CASE WHEN s.enabled = 1 THEN 'true' ELSE 'false' END),
    'does', 'message',
    'agent', s.session_id,
    'prompt', s.prompt,
    'fresh', json_object('harness', 'claude', 'model', NULL, 'role', NULL, 'closeWhenDone', json('true')),
    'result', 'history',
    'handoffTo', NULL,
    'folded', json('false')
  )
FROM schedules s
JOIN agents a ON a.session_id = s.session_id;

INSERT INTO clock_runs (clock_id, due_at, fired_at, outcome, reason, session_id, agent_name)
SELECT 'clock-' || r.session_id, r.due_at, r.fired_at, r.outcome, r.reason, r.session_id, a.name
FROM schedule_runs r
JOIN agents a ON a.session_id = r.session_id
ORDER BY r.id;

DROP TABLE schedule_runs;
DROP TABLE schedules;

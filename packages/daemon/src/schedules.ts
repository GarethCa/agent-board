import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from './clock.ts';
import { nextRun, parseCron, type Cron } from './cron.ts';
import { CLOCK_RUNS_KEPT, type AgentSchedule, type ClockData, type ClockRun, type ClockRunOutcome, type ClockStatus } from './protocol.ts';

/**
 * The longest the scheduler sleeps before it looks at the clock again. Timers don't count time the machine spends
 * asleep, so a fire time it slept through goes off within a minute of waking.
 */
const MAX_TIMER_MS = 60_000;

/**
 * How a run or a delivery went: started, or not and why; `busy` when only because the agent can't take it now.
 * `unsent` when it was typed at a live agent's prompt but no turn started: it is still there, unsent.
 */
export type RunStart = { started: true; unsent?: boolean } | { started: false; reason: string; busy?: boolean };

/** A clock as the scheduler fires it: its item id, its zone and its data. */
export interface FiringClock {
  id: string;
  zoneId: string | null;
  x: number;
  y: number;
  height: number;
  data: ClockData;
}

/**
 * What firing a clock did: a run that started or skipped at once, or one still `running` (a fresh agent's), which
 * `start` begins once its run has its row.
 */
export type Fired = (RunStart & { sessionId?: string; agentName?: string }) | { running: true; start(runId: number): void };

/** What a run's row may be changed to, once it has fired. */
export interface RunPatch {
  outcome?: ClockRunOutcome;
  reason?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  finishedAt?: string | null;
  result?: string | null;
}

export interface ScheduleHostOptions {
  db: DatabaseSync;
  clock: Clock;
  /**
   * Does what the clock does: messages its agent, or starts a fresh agent (`running`, until `ScheduleHost.updateRun`
   * settles its run). `count` is which run of the clock it is, from 1.
   */
  fire(clock: FiringClock, count: number): Fired;
  /** Called after a clock is planned again or fires, or a run of it changes, so clients hear of it. */
  onChange(clockId: string): void;
  log(message: string): void;
}

export interface ScheduleHost {
  /** Plans the clock again from its item as stored now: after it is made, changed or deleted. */
  replan(clockId: string): void;
  /** The clock's status, or null if there is no such clock. */
  status(clockId: string): ClockStatus | null;
  statuses(): ClockStatus[];
  /** The agent's schedule: the clock that messages it, the soonest of them; null if none does. */
  forAgent(sessionId: string): AgentSchedule | null;
  /** The ids of the clocks that message the agent, or hand fresh agents' results to it. */
  joinedTo(sessionId: string): string[];
  /** The run a fresh agent is doing, if it is one. */
  runOf(sessionId: string): { runId: number; clockId: string } | undefined;
  /** Every run still `running`, as left by a daemon that stopped during it too. */
  running(): { runId: number; clockId: string; sessionId: string | null; result: string | null }[];
  /** Changes a run, and tells clients. */
  updateRun(runId: number, patch: RunPatch): void;
  /** Whether any clock is planned: the daemon stays up for them. */
  hasEnabled(): boolean;
  /** Stops firing. */
  close(): void;
}

interface ItemRow {
  id: string;
  zone_id: string | null;
  x: number;
  y: number;
  height: number;
  data: string;
}

interface RunRow {
  id: number;
  clock_id: string;
  due_at: string;
  fired_at: string;
  outcome: ClockRunOutcome;
  reason: string | null;
  session_id: string | null;
  agent_name: string | null;
  finished_at: string | null;
  result: string | null;
}

/** Whether the clock has what it needs to fire: on, a prompt, and an agent to message or a zone to start one in. */
function clockIsSet(data: ClockData, zoneId: string | null): boolean {
  if (!data.enabled || data.prompt.trim() === '') return false;
  return data.does === 'message' ? data.agent !== null : zoneId !== null;
}

/**
 * Fires the clocks on the board (board items of kind `clock`). Their schedules live in the items' data, so they survive
 * restarts; their next fire times are worked out from the time whenever the scheduler starts or a clock changes, so a
 * fire time that passed while the daemon was down is not caught up on. Each time a clock fires, the run it started,
 * or why it skipped, is recorded in `clock_runs`; one whose last run is still going skips.
 *
 * Every time it wakes (at least once a minute) it works out again each fire time not yet due, so a clock set back, or
 * a change of time zone (`process.env.TZ`), moves the fire times with it.
 */
export function createScheduleHost(options: ScheduleHostOptions): ScheduleHost {
  const { db, clock } = options;
  const select = "SELECT id, zone_id, x, y, height, data FROM board_items WHERE kind = 'clock'";
  const selectOne = db.prepare(`${select} AND id = ?`);
  const selectAll = db.prepare(`${select} ORDER BY z, rowid`);
  const selectMessaging = db.prepare(
    `${select} AND json_extract(data, '$.does') = 'message' AND json_extract(data, '$.agent') = ? ORDER BY z, rowid`,
  );
  const selectJoined = db.prepare(
    `SELECT id FROM board_items WHERE kind = 'clock' AND (json_extract(data, '$.agent') = ? OR json_extract(data, '$.handoffTo') = ?)`,
  );
  const insertRun = db.prepare(
    'INSERT INTO clock_runs (clock_id, due_at, fired_at, outcome, reason, session_id, agent_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  );
  const selectRun = db.prepare('SELECT * FROM clock_runs WHERE id = ?');
  const selectRuns = db.prepare('SELECT * FROM clock_runs WHERE clock_id = ? ORDER BY id DESC LIMIT ?');
  const countRuns = db.prepare('SELECT count(*) AS count FROM clock_runs WHERE clock_id = ?');
  const selectRunning = db.prepare("SELECT * FROM clock_runs WHERE outcome = 'running' ORDER BY id");
  const selectRunningOf = db.prepare("SELECT id FROM clock_runs WHERE clock_id = ? AND outcome = 'running' LIMIT 1");
  const selectRunOf = db.prepare("SELECT id, clock_id FROM clock_runs WHERE session_id = ? AND outcome = 'running' LIMIT 1");
  const updateRunRow = db.prepare(
    `UPDATE clock_runs SET outcome = coalesce(?, outcome), reason = ?, session_id = ?, agent_name = ?, finished_at = ?, result = ? WHERE id = ?`,
  );

  /** Each planned clock's cron, parsed, and next fire time. */
  const due = new Map<string, { text: string; cron: Cron; at: number }>();
  let cancelTimer: (() => void) | undefined;
  let closed = false;

  const parsedRow = (row: ItemRow): FiringClock => ({
    id: row.id,
    zoneId: row.zone_id,
    x: row.x,
    y: row.y,
    height: row.height,
    data: JSON.parse(row.data) as ClockData,
  });

  /**
   * Plans the clock's next fire time from now, or forgets it if it can't fire. One already planned on the same cron
   * keeps its time: a drag or a fold as it falls due, or after a sleep, doesn't lose that fire.
   */
  const plan = (row: ItemRow | undefined, id: string) => {
    const firing = row === undefined ? undefined : parsedRow(row);
    if (firing === undefined || !clockIsSet(firing.data, firing.zoneId)) {
      due.delete(id);
      return;
    }
    if (due.get(id)?.text === firing.data.cron) return;
    try {
      const cron = parseCron(firing.data.cron);
      due.set(id, { text: firing.data.cron, cron, at: nextRun(cron, new Date(clock.now())).getTime() });
    } catch (error) {
      due.delete(id);
      options.log(`ignoring clock ${id}: ${(error as Error).message}`);
    }
  };

  /** Sets the timer for the earliest fire time, or at most `MAX_TIMER_MS` from now. */
  const arm = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (closed || due.size === 0) return;
    const earliest = Math.min(...[...due.values()].map((entry) => entry.at));
    cancelTimer = clock.setTimer(tick, Math.min(Math.max(0, earliest - clock.now()), MAX_TIMER_MS));
  };

  const fire = (firing: FiringClock, dueAt: number, now: number) => {
    const times = [new Date(dueAt).toISOString(), new Date(now).toISOString()] as const;
    const insert = (outcome: ClockRunOutcome, reason: string | null, sessionId: string | null = null, agentName: string | null = null) =>
      (insertRun.get(firing.id, ...times, outcome, reason, sessionId, agentName) as { id: number }).id;
    if (selectRunningOf.get(firing.id) !== undefined) {
      insert('skipped', 'its last run is still going');
      options.log(`clock ${firing.id} skipped: its last run is still going`);
      options.onChange(firing.id);
      return;
    }
    const { count } = countRuns.get(firing.id) as { count: number };
    let fired: Fired;
    try {
      fired = options.fire(firing, count + 1);
    } catch (error) {
      fired = { started: false, reason: (error as Error).message };
    }
    if ('running' in fired) {
      fired.start(insert('running', null));
      options.log(`clock ${firing.id} fired: starting a fresh agent`);
    } else {
      const reason = fired.started ? null : fired.reason;
      insert(fired.started ? 'started' : 'skipped', reason, fired.sessionId ?? null, fired.agentName ?? null);
      options.log(`clock ${firing.id} fired: ${reason === null ? 'started a run' : `skipped, ${reason}`}`);
    }
    options.onChange(firing.id);
  };

  function tick() {
    cancelTimer = undefined;
    const now = clock.now();
    for (const [id, entry] of due) {
      if (entry.at <= now) {
        const row = selectOne.get(id) as ItemRow | undefined;
        // Deleted since it was planned.
        if (row === undefined) {
          due.delete(id);
          continue;
        }
        fire(parsedRow(row), entry.at, now);
      }
      // Once for however many fire times were missed, then on from now. One not yet due is worked out again too: the
      // same time unless the clock went back or the time zone changed.
      if (due.has(id)) entry.at = nextRun(entry.cron, new Date(now)).getTime();
    }
    arm();
  }

  const toRun = (row: RunRow): ClockRun => ({
    id: row.id,
    dueAt: row.due_at,
    firedAt: row.fired_at,
    outcome: row.outcome,
    reason: row.reason,
    sessionId: row.session_id,
    agentName: row.agent_name,
    finishedAt: row.finished_at,
    result: row.result,
  });

  const nextRunAt = (id: string): string | null => {
    const next = due.get(id);
    return next === undefined ? null : new Date(next.at).toISOString();
  };

  const status = (id: string): ClockStatus | null => {
    if (selectOne.get(id) === undefined) return null;
    return { id, nextRunAt: nextRunAt(id), runs: (selectRuns.all(id, CLOCK_RUNS_KEPT) as unknown as RunRow[]).map(toRun) };
  };

  function updateRun(runId: number, patch: RunPatch) {
    const row = selectRun.get(runId) as RunRow | undefined;
    if (row === undefined) return;
    const pick = <K extends keyof RunPatch>(key: K, was: RunPatch[K]) => (key in patch ? patch[key] : was) ?? null;
    updateRunRow.run(
      patch.outcome ?? null,
      pick('reason', row.reason),
      pick('sessionId', row.session_id),
      pick('agentName', row.agent_name),
      pick('finishedAt', row.finished_at),
      pick('result', row.result),
      runId,
    );
  }

  for (const row of selectAll.all() as unknown as ItemRow[]) plan(row, row.id);
  arm();

  return {
    replan(clockId) {
      plan(selectOne.get(clockId) as ItemRow | undefined, clockId);
      arm();
      options.onChange(clockId);
    },

    status,
    statuses: () => (selectAll.all() as unknown as ItemRow[]).map((row) => status(row.id)!),

    forAgent(sessionId) {
      const rows = selectMessaging.all(sessionId) as unknown as ItemRow[];
      if (rows.length === 0) return null;
      // The soonest it fires, else the first made.
      const planned = rows.filter((row) => due.has(row.id)).sort((a, b) => due.get(a.id)!.at - due.get(b.id)!.at);
      const row = planned[0] ?? rows[0]!;
      const data = parsedRow(row).data;
      const last = (selectRuns.all(row.id, 1) as unknown as RunRow[])[0];
      return {
        clockId: row.id,
        cron: data.cron,
        prompt: data.prompt,
        enabled: data.enabled,
        nextRunAt: nextRunAt(row.id),
        lastRun: last === undefined ? null : { dueAt: last.due_at, firedAt: last.fired_at, outcome: last.outcome, reason: last.reason },
      };
    },

    joinedTo: (sessionId) => (selectJoined.all(sessionId, sessionId) as { id: string }[]).map((row) => row.id),

    runOf(sessionId) {
      const row = selectRunOf.get(sessionId) as { id: number; clock_id: string } | undefined;
      return row === undefined ? undefined : { runId: row.id, clockId: row.clock_id };
    },

    running: () => (selectRunning.all() as unknown as RunRow[]).map((row) => ({ runId: row.id, clockId: row.clock_id, sessionId: row.session_id, result: row.result })),

    updateRun(runId, patch) {
      // A run settling as the daemon shuts down is settled once it starts again.
      if (closed) return;
      updateRun(runId, patch);
      const row = selectRun.get(runId) as RunRow | undefined;
      if (row !== undefined) options.onChange(row.clock_id);
    },

    hasEnabled: () => due.size > 0,

    close() {
      closed = true;
      arm();
    },
  };
}

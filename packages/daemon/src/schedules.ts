import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from './clock.ts';
import { CronError, nextRun, parseCron, type Cron } from './cron.ts';
import { invalidParams } from './params.ts';
import type { AgentSchedule, ScheduleRun, ScheduleSpec } from './protocol.ts';

/**
 * The longest the scheduler sleeps before it looks at the clock again. Timers don't count time the machine spends
 * asleep, so a fire time it slept through goes off within a minute of waking.
 */
const MAX_TIMER_MS = 60_000;

/** How a run or a delivery went: started, or not and why; `busy` when only because the agent can't take it now. */
export type RunStart = { started: true } | { started: false; reason: string; busy?: boolean };

export interface ScheduleHostOptions {
  db: DatabaseSync;
  clock: Clock;
  /**
   * Starts a run of the agent: sends it `prompt` as its next message, relaunching it if its session has ended, unless
   * it can't take one now.
   */
  run(sessionId: string, prompt: string): RunStart;
  /** Called after a schedule fires, so clients hear of its last run and next run. */
  onChange(sessionId: string): void;
  log(message: string): void;
}

export interface ScheduleHost {
  /** The agent's schedule, or null if it has none. */
  get(sessionId: string): AgentSchedule | null;
  /** Gives the agent a schedule, replacing any it had. Throws `invalidParams` for an unusable cron or an empty prompt. */
  set(sessionId: string, spec: ScheduleSpec): AgentSchedule;
  remove(sessionId: string): void;
  /** Whether any agent has an enabled schedule: the daemon stays up for them. */
  hasEnabled(): boolean;
  /** Stops firing. */
  close(): void;
}

interface ScheduleRow {
  session_id: string;
  cron: string;
  prompt: string;
  enabled: number;
}

interface RunRow {
  due_at: string;
  fired_at: string;
  outcome: ScheduleRun['outcome'];
  reason: string | null;
}

/**
 * Fires long-lived agents' cron schedules. Schedules live in the database, so they survive restarts; their
 * next fire times are worked out from the clock whenever the scheduler starts or a schedule is set, so a fire time
 * that passed while the daemon was down is not caught up on. A schedule fires whether or not its agent's session is
 * live: `run` relaunches an ended agent. Each time it fires, the run it started, or why it skipped, is recorded in
 * `schedule_runs`.
 *
 * Every time it wakes (at least once a minute) it works out again each fire time not yet due, so a clock set back, or
 * a change of time zone (`process.env.TZ`), moves the fire times with it.
 */
export function createScheduleHost(options: ScheduleHostOptions): ScheduleHost {
  const { db, clock } = options;
  const select = 'SELECT session_id, cron, prompt, enabled FROM schedules';
  const selectOne = db.prepare(`${select} WHERE session_id = ?`);
  const selectAll = db.prepare(select);
  const upsert = db.prepare(
    `INSERT INTO schedules (session_id, cron, prompt, enabled) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET cron = excluded.cron, prompt = excluded.prompt, enabled = excluded.enabled`,
  );
  const deleteSchedule = db.prepare('DELETE FROM schedules WHERE session_id = ?');
  const insertRun = db.prepare(
    'INSERT INTO schedule_runs (session_id, due_at, fired_at, outcome, reason) VALUES (?, ?, ?, ?, ?)',
  );
  const selectLastRun = db.prepare(
    'SELECT due_at, fired_at, outcome, reason FROM schedule_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1',
  );

  /** Each enabled schedule's parsed cron and next fire time. */
  const due = new Map<string, { cron: Cron; at: number }>();
  let cancelTimer: (() => void) | undefined;
  let closed = false;

  /** Plans the schedule's next fire time from now, or forgets it if it is disabled. */
  const plan = (sessionId: string, cron: Cron, enabled: boolean) => {
    if (enabled) due.set(sessionId, { cron, at: nextRun(cron, new Date(clock.now())).getTime() });
    else due.delete(sessionId);
  };

  /** Sets the timer for the earliest fire time, or at most `MAX_TIMER_MS` from now. */
  const arm = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (closed || due.size === 0) return;
    const earliest = Math.min(...[...due.values()].map((entry) => entry.at));
    cancelTimer = clock.setTimer(tick, Math.min(Math.max(0, earliest - clock.now()), MAX_TIMER_MS));
  };

  const fire = (row: ScheduleRow, dueAt: number, now: number) => {
    let start: RunStart;
    try {
      start = options.run(row.session_id, row.prompt);
    } catch (error) {
      start = { started: false, reason: (error as Error).message };
    }
    const reason = start.started ? null : start.reason;
    insertRun.run(row.session_id, new Date(dueAt).toISOString(), new Date(now).toISOString(), start.started ? 'started' : 'skipped', reason);
    options.log(`schedule for agent ${row.session_id} fired: ${reason === null ? 'started a run' : `skipped, ${reason}`}`);
    options.onChange(row.session_id);
  };

  function tick() {
    cancelTimer = undefined;
    const now = clock.now();
    for (const [sessionId, entry] of due) {
      if (entry.at <= now) {
        const row = selectOne.get(sessionId) as ScheduleRow | undefined;
        // Deleted with its agent since it was planned.
        if (row === undefined) {
          due.delete(sessionId);
          continue;
        }
        fire(row, entry.at, now);
      }
      // Once for however many fire times were missed, then on from now. One not yet due is worked out again too: the
      // same time unless the clock went back or the time zone changed.
      entry.at = nextRun(entry.cron, new Date(now)).getTime();
    }
    arm();
  }

  const toSchedule = (row: ScheduleRow): AgentSchedule => {
    const run = selectLastRun.get(row.session_id) as RunRow | undefined;
    const next = due.get(row.session_id);
    return {
      cron: row.cron,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      nextRunAt: next === undefined ? null : new Date(next.at).toISOString(),
      lastRun: run === undefined ? null : { dueAt: run.due_at, firedAt: run.fired_at, outcome: run.outcome, reason: run.reason },
    };
  };

  const get = (sessionId: string): AgentSchedule | null => {
    const row = selectOne.get(sessionId) as ScheduleRow | undefined;
    return row === undefined ? null : toSchedule(row);
  };

  for (const row of selectAll.all() as unknown as ScheduleRow[]) {
    try {
      plan(row.session_id, parseCron(row.cron), row.enabled === 1);
    } catch (error) {
      options.log(`ignoring the schedule of agent ${row.session_id}: ${(error as Error).message}`);
    }
  }
  arm();

  return {
    get,

    set(sessionId, { cron, prompt, enabled = true }) {
      const expression = cron.trim();
      let parsed: Cron;
      try {
        parsed = parseCron(expression);
      } catch (error) {
        if (error instanceof CronError) throw invalidParams(error.message);
        throw error;
      }
      const text = prompt.trim();
      if (text === '') throw invalidParams('the prompt must not be empty');
      upsert.run(sessionId, expression, text, enabled ? 1 : 0);
      plan(sessionId, parsed, enabled);
      arm();
      return get(sessionId)!;
    },

    remove(sessionId) {
      deleteSchedule.run(sessionId);
      due.delete(sessionId);
      arm();
    },

    hasEnabled: () => due.size > 0,

    close() {
      closed = true;
      arm();
    },
  };
}

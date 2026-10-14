import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.ts';
import { RPC_ERROR } from '../src/protocol.ts';
import { createScheduleHost, type RunStart, type ScheduleHost } from '../src/schedules.ts';
import { createFakeClock, type FakeClock } from './fake-clock.ts';
import { pinTimeZone } from './pin-time-zone.ts';

pinTimeZone('Europe/London');

/** Local time, months from 1. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second);

/** A Saturday morning. */
const START = at(2026, 10, 10, 7, 30, 15);

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  db.prepare("INSERT INTO zones (id, repo_root, name, color, x, y, width, height) VALUES ('z', '/repo', 'repo', '#fff', 0, 0, 1, 1)").run();
  return db;
}

function addAgent(db: DatabaseSync, id: string): { end(): void } {
  db.prepare("INSERT INTO sessions (id, harness, hook_token_sha256) VALUES (?, 'claude', ?)").run(id, `hash-${id}`);
  db.prepare(
    "INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state) VALUES (?, 'z', '/r', 1, ?, '', 'b', '/w', 'idle')",
  ).run(id, id);
  return { end: () => db.prepare("UPDATE sessions SET ended_at = 'x' WHERE id = ?").run(id) };
}

interface Harness {
  db: DatabaseSync;
  clock: FakeClock;
  schedules: ScheduleHost;
  /** Every run the scheduler asked for, with the time it asked. */
  runs: { sessionId: string; prompt: string; at: Date }[];
  changed: string[];
  /** What the next runs answer: started, unless set. */
  answer: { next: RunStart };
}

function scheduler(options: { db?: DatabaseSync; clock?: FakeClock } = {}): Harness {
  const db = options.db ?? database();
  const clock = options.clock ?? createFakeClock(START);
  const runs: Harness['runs'] = [];
  const changed: string[] = [];
  const answer: Harness['answer'] = { next: { started: true } };
  const schedules = createScheduleHost({
    db,
    clock,
    run(sessionId, prompt) {
      runs.push({ sessionId, prompt, at: new Date(clock.now()) });
      return answer.next;
    },
    onChange: (sessionId) => changed.push(sessionId),
    log: () => {},
  });
  return { db, clock, schedules, runs, changed, answer };
}

describe('schedules', () => {
  it('fires a run at each fire time, on the minute, with its prompt', () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '*/15 * * * *', prompt: 'Check the build' });

    clock.advanceTo(at(2026, 10, 10, 7, 44, 59));
    expect(runs).toEqual([]);
    clock.advance(1_000);
    expect(runs).toEqual([{ sessionId: 'a', prompt: 'Check the build', at: at(2026, 10, 10, 7, 45) }]);
    clock.advanceTo(at(2026, 10, 10, 9, 0));
    expect(runs.map((run) => run.at)).toEqual([
      at(2026, 10, 10, 7, 45),
      at(2026, 10, 10, 8, 0),
      at(2026, 10, 10, 8, 15),
      at(2026, 10, 10, 8, 30),
      at(2026, 10, 10, 8, 45),
      at(2026, 10, 10, 9, 0),
    ]);
  });

  it("shows the next run, and the last one's outcome once it has fired", () => {
    const { db, clock, schedules } = scheduler();
    addAgent(db, 'a');

    expect(schedules.set('a', { cron: '0 9 * * 1-5', prompt: 'Triage' })).toEqual({
      cron: '0 9 * * 1-5',
      prompt: 'Triage',
      enabled: true,
      nextRunAt: at(2026, 10, 12, 9).toISOString(),
      lastRun: null,
    });
    clock.advanceTo(at(2026, 10, 12, 9));
    expect(schedules.get('a')).toMatchObject({
      nextRunAt: at(2026, 10, 13, 9).toISOString(),
      lastRun: { dueAt: at(2026, 10, 12, 9).toISOString(), firedAt: at(2026, 10, 12, 9).toISOString(), outcome: 'started', reason: null },
    });
  });

  it('records a run skipped because the agent was busy, and fires again at the next time', () => {
    const { db, clock, schedules, runs, answer } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '0 * * * *', prompt: 'Sweep' });
    answer.next = { started: false, reason: 'it was still running' };

    clock.advanceTo(at(2026, 10, 10, 8));
    expect(schedules.get('a')!.lastRun).toMatchObject({ outcome: 'skipped', reason: 'it was still running' });
    answer.next = { started: true };
    clock.advanceTo(at(2026, 10, 10, 9));
    expect(runs).toHaveLength(2);
    expect(schedules.get('a')!.lastRun).toMatchObject({ outcome: 'started', reason: null });
    expect(db.prepare('SELECT outcome, reason FROM schedule_runs ORDER BY id').all()).toEqual([
      { outcome: 'skipped', reason: 'it was still running' },
      { outcome: 'started', reason: null },
    ]);
  });

  it('tells clients when a schedule is set or fires', () => {
    const { db, clock, schedules, changed } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '0 8 * * *', prompt: 'Sweep' });
    expect(changed).toEqual([]); // the caller announces what it set
    clock.advanceTo(at(2026, 10, 10, 8));
    expect(changed).toEqual(['a']);
  });

  it('keeps schedules across restarts, firing from the next time after the restart', () => {
    const db = database();
    addAgent(db, 'a');
    const first = scheduler({ db });
    first.schedules.set('a', { cron: '0 8 * * *', prompt: 'Sweep', enabled: true });
    first.schedules.close();

    const clock = createFakeClock(at(2026, 10, 11, 12));
    const second = scheduler({ db, clock });
    expect(second.schedules.get('a')).toMatchObject({ cron: '0 8 * * *', prompt: 'Sweep', enabled: true, nextRunAt: at(2026, 10, 12, 8).toISOString() });
    clock.advanceTo(at(2026, 10, 12, 8));
    expect(second.runs).toHaveLength(1);
    expect(first.runs).toHaveLength(0);
  });

  it('never fires a disabled schedule', () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    expect(schedules.set('a', { cron: '* * * * *', prompt: 'Sweep', enabled: false })).toMatchObject({ enabled: false, nextRunAt: null });
    clock.advance(60 * 60_000);
    expect(runs).toEqual([]);
  });

  it("fires for an agent whose session has ended: starting the run is the agent host's job", () => {
    const { db, clock, schedules, runs } = scheduler();
    const agent = addAgent(db, 'a');
    schedules.set('a', { cron: '0 8 * * *', prompt: 'Sweep' });
    agent.end();

    expect(schedules.get('a')).toMatchObject({ enabled: true, nextRunAt: at(2026, 10, 10, 8).toISOString() });
    clock.advanceTo(at(2026, 10, 10, 8));
    expect(runs).toEqual([{ sessionId: 'a', prompt: 'Sweep', at: at(2026, 10, 10, 8) }]);
  });

  it('says whether any schedule is enabled, which keeps the daemon up', () => {
    const { db, schedules } = scheduler();
    addAgent(db, 'a');
    expect(schedules.hasEnabled()).toBe(false);
    schedules.set('a', { cron: '@daily', prompt: 'Sweep', enabled: false });
    expect(schedules.hasEnabled()).toBe(false);
    schedules.set('a', { cron: '@daily', prompt: 'Sweep' });
    expect(schedules.hasEnabled()).toBe(true);
    schedules.remove('a');
    expect(schedules.hasEnabled()).toBe(false);
  });

  it('fires on time after the clock is set back, as when NTP corrects a fast clock', () => {
    // The clock runs a day fast when the schedule is set, so it plans the 09:00 of the wrong day.
    const { db, clock, schedules, runs } = scheduler({ clock: createFakeClock(at(2026, 10, 11, 7, 30)) });
    addAgent(db, 'a');
    schedules.set('a', { cron: '0 9 * * *', prompt: 'Sweep' });
    expect(schedules.get('a')!.nextRunAt).toBe(at(2026, 10, 11, 9).toISOString());

    clock.setBack(24 * 60 * 60_000);
    clock.advanceTo(at(2026, 10, 10, 9));
    expect(runs.map((run) => run.at)).toEqual([at(2026, 10, 10, 9)]);
    expect(schedules.get('a')!.nextRunAt).toBe(at(2026, 10, 11, 9).toISOString());
  });

  it("follows a change of time zone, firing at the new zone's wall-clock time", () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '0 9 * * *', prompt: 'Sweep' });
    try {
      // New York is five hours behind London: its 09:00 is London's 14:00.
      process.env.TZ = 'America/New_York';
      clock.advance(60_000);
      expect(schedules.get('a')!.nextRunAt).toBe(new Date(Date.UTC(2026, 9, 10, 13)).toISOString());
      clock.advanceTo(new Date(Date.UTC(2026, 9, 10, 13)));
      expect(runs.map((run) => run.at.toISOString())).toEqual([new Date(Date.UTC(2026, 9, 10, 13)).toISOString()]);
    } finally {
      process.env.TZ = 'Europe/London';
    }
  });

  it('fires once, late, for fire times the machine slept through, then carries on from then', () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '0 * * * *', prompt: 'Sweep' });

    clock.sleep(3 * 60 * 60_000 + 10 * 60_000); // wakes at 10:40:15
    expect(runs.map((run) => run.at)).toEqual([at(2026, 10, 10, 10, 40, 15)]);
    expect(schedules.get('a')).toMatchObject({
      nextRunAt: at(2026, 10, 10, 11).toISOString(),
      lastRun: { dueAt: at(2026, 10, 10, 8).toISOString(), firedAt: at(2026, 10, 10, 10, 40, 15).toISOString() },
    });
  });

  it('replaces a schedule, or removes it', () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '0 12 * * *', prompt: 'Old' });
    schedules.set('a', { cron: '0 8 * * *', prompt: 'New' });
    clock.advanceTo(at(2026, 10, 10, 12));
    expect(runs.map((run) => [run.prompt, run.at])).toEqual([['New', at(2026, 10, 10, 8)]]);

    schedules.remove('a');
    expect(schedules.get('a')).toBeNull();
    clock.advanceTo(at(2026, 10, 12));
    expect(runs).toHaveLength(1);
  });

  it('runs each agent on its own schedule', () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    addAgent(db, 'b');
    schedules.set('a', { cron: '0 8 * * *', prompt: 'A' });
    schedules.set('b', { cron: '45 7-8 * * *', prompt: 'B' });
    clock.advanceTo(at(2026, 10, 10, 9));
    expect(runs.map((run) => [run.sessionId, run.at])).toEqual([
      ['b', at(2026, 10, 10, 7, 45)],
      ['a', at(2026, 10, 10, 8)],
      ['b', at(2026, 10, 10, 8, 45)],
    ]);
  });

  it("goes when its agent is deleted", () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '* * * * *', prompt: 'Sweep' });
    clock.advance(60_000);
    db.prepare("DELETE FROM agents WHERE session_id = 'a'").run();

    expect(schedules.get('a')).toBeNull();
    clock.advance(10 * 60_000);
    expect(runs).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM schedule_runs').get()).toEqual({ n: 0 });
  });

  it('refuses a cron expression it cannot use, saying why, or an empty prompt', () => {
    const { db, schedules } = scheduler();
    addAgent(db, 'a');
    expect(() => schedules.set('a', { cron: '61 * * * *', prompt: 'Sweep' })).toThrow(
      expect.objectContaining({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('minute') }),
    );
    expect(() => schedules.set('a', { cron: '@daily', prompt: '   ' })).toThrow(
      expect.objectContaining({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('prompt') }),
    );
    expect(schedules.get('a')).toBeNull();
  });

  it('trims the cron expression and prompt it keeps', () => {
    const { db, schedules } = scheduler();
    addAgent(db, 'a');
    expect(schedules.set('a', { cron: ' @daily ', prompt: '  Sweep\n' })).toMatchObject({ cron: '@daily', prompt: 'Sweep' });
  });

  it('stops firing once closed', () => {
    const { db, clock, schedules, runs } = scheduler();
    addAgent(db, 'a');
    schedules.set('a', { cron: '* * * * *', prompt: 'Sweep' });
    schedules.close();
    clock.advance(10 * 60_000);
    expect(runs).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.ts';
import type { ClockData } from '../src/protocol.ts';
import { createScheduleHost, type Fired, type ScheduleHost } from '../src/schedules.ts';
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

/** A clock that messages agent `a`, at the place a clock goes. */
const clockData = (data: Partial<ClockData>): ClockData => ({
  cron: '@daily',
  enabled: true,
  does: 'message',
  agent: 'a',
  prompt: 'Sweep',
  fresh: { harness: 'claude', model: null, role: null, closeWhenDone: true },
  result: 'history',
  handoffTo: null,
  folded: false,
  ...data,
});

interface Harness {
  db: DatabaseSync;
  clock: FakeClock;
  schedules: ScheduleHost;
  /** Every clock fired, with its prompt, the agent it messages and the time it fired. */
  runs: { clockId: string; agent: string | null; prompt: string; at: Date }[];
  changed: string[];
  /** What the next firings answer: started, unless set; `during` runs as each fires. */
  answer: { next: Fired; during?: (clockId: string) => void };
  /** Makes or changes clock `id`, as the item store does, and tells the scheduler. */
  set(id: string, data: Partial<ClockData>, zoneId?: string | null): void;
  remove(id: string): void;
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
    fire(firing) {
      runs.push({ clockId: firing.id, agent: firing.data.agent, prompt: firing.data.prompt, at: new Date(clock.now()) });
      answer.during?.(firing.id);
      return answer.next;
    },
    onChange: (clockId) => changed.push(clockId),
    log: () => {},
  });
  const set = (id: string, data: Partial<ClockData>, zoneId: string | null = 'z') => {
    db.prepare(
      `INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES (?, 'clock', ?, 0, 0, 256, 76, 1, ?)
       ON CONFLICT (id) DO UPDATE SET zone_id = excluded.zone_id, data = excluded.data`,
    ).run(id, zoneId, JSON.stringify(clockData(data)));
    schedules.replan(id);
  };
  const remove = (id: string) => {
    db.prepare('DELETE FROM board_items WHERE id = ?').run(id);
    schedules.replan(id);
  };
  return { db, clock, schedules, runs, changed, answer, set, remove };
}

describe('schedules', () => {
  it('fires a clock at each fire time, on the minute, with its prompt', () => {
    const { clock, runs, set } = scheduler();
    set('c', { cron: '*/15 * * * *', prompt: 'Check the build' });

    clock.advanceTo(at(2026, 10, 10, 7, 44, 59));
    expect(runs).toEqual([]);
    clock.advance(1_000);
    expect(runs).toEqual([{ clockId: 'c', agent: 'a', prompt: 'Check the build', at: at(2026, 10, 10, 7, 45) }]);
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

  it("shows the next run, and the runs it has had, newest first", () => {
    const { clock, schedules, set, answer } = scheduler();
    set('c', { cron: '0 9 * * 1-5', prompt: 'Triage' });

    expect(schedules.status('c')).toEqual({ id: 'c', nextRunAt: at(2026, 10, 12, 9).toISOString(), runs: [], skips: null, changes: [] });
    answer.next = { started: true, sessionId: 'a', agentName: 'Triager' };
    clock.advanceTo(at(2026, 10, 12, 9));
    answer.next = { started: false, reason: 'it was still running' };
    clock.advanceTo(at(2026, 10, 13, 9));
    expect(schedules.status('c')).toEqual({
      id: 'c',
      nextRunAt: at(2026, 10, 14, 9).toISOString(),
      runs: [
        expect.objectContaining({ dueAt: at(2026, 10, 13, 9).toISOString(), outcome: 'skipped', reason: 'it was still running', sessionId: null }),
        expect.objectContaining({ dueAt: at(2026, 10, 12, 9).toISOString(), firedAt: at(2026, 10, 12, 9).toISOString(), outcome: 'started', reason: null, sessionId: 'a', agentName: 'Triager' }),
      ],
      skips: { count: 1, since: at(2026, 10, 13, 9).toISOString(), reasons: ['it was still running'] },
      changes: [],
    });
  });

  it('counts the skips in a row whatever their reasons, from the first of them, past the runs it keeps', () => {
    const { clock, schedules, set, answer } = scheduler();
    set('c', { cron: '*/1 * * * *' });
    clock.advanceTo(at(2026, 10, 10, 7, 31));
    answer.next = { started: false, reason: 'it was waiting for you' };
    clock.advanceTo(at(2026, 10, 10, 7, 32));
    answer.next = { started: false, reason: 'it was still working', busy: true };
    clock.advanceTo(at(2026, 10, 10, 7, 57));
    const since = at(2026, 10, 10, 7, 32).toISOString();
    expect(schedules.status('c')!.skips).toEqual({ count: 26, since, reasons: ['it was still working', 'it was waiting for you'] });
    expect(schedules.status('c')!.runs.length).toBeLessThan(26);

    answer.next = { started: false, reason: 'it was waiting for you' };
    clock.advanceTo(at(2026, 10, 10, 7, 58));
    expect(schedules.status('c')!.skips).toEqual({ count: 27, since, reasons: ['it was waiting for you', 'it was still working'] });

    answer.next = { started: true };
    clock.advanceTo(at(2026, 10, 10, 7, 59));
    expect(schedules.status('c')!.skips).toBeNull();
  });

  it('tells its caller of each run as it is recorded, with the skips in a row', () => {
    const fired: { id: string; count: number | null }[] = [];
    const db = database();
    const clock = createFakeClock(START);
    const schedules = createScheduleHost({
      db,
      clock,
      fire: () => ({ started: false, reason: 'it was still working', busy: true }),
      afterFire: (firing, status) => fired.push({ id: firing.id, count: status.skips?.count ?? null }),
      onChange: () => {},
      log: () => {},
    });
    db.prepare("INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES ('c', 'clock', 'z', 0, 0, 256, 76, 1, ?)").run(
      JSON.stringify(clockData({ cron: '*/1 * * * *' })),
    );
    schedules.replan('c');
    clock.advanceTo(at(2026, 10, 10, 7, 33));
    expect(fired).toEqual([
      { id: 'c', count: 1 },
      { id: 'c', count: 2 },
      { id: 'c', count: 3 },
    ]);
  });

  it('goes on firing when its caller throws after a run, and logs it', () => {
    const logged: string[] = [];
    let fires = 0;
    const db = database();
    const clock = createFakeClock(START);
    const schedules = createScheduleHost({
      db,
      clock,
      fire: () => ({ started: false, reason: 'it was still working', busy: true }),
      afterFire: () => {
        fires += 1;
        throw new Error('no flag');
      },
      onChange: () => {},
      log: (line) => logged.push(line),
    });
    db.prepare("INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES ('c', 'clock', 'z', 0, 0, 256, 76, 1, ?)").run(
      JSON.stringify(clockData({ cron: '*/1 * * * *' })),
    );
    schedules.replan('c');
    clock.advanceTo(at(2026, 10, 10, 7, 33));
    expect(fires).toBe(3);
    expect(logged).toContain('clock c: after its run: no flag');
  });

  it("gives an agent the schedule of the clock that messages it, the soonest of several", () => {
    const { clock, schedules, set } = scheduler();
    set('later', { cron: '0 12 * * *', prompt: 'Lunch' });
    set('sooner', { cron: '0 8 * * *', prompt: 'Breakfast' });
    set('other', { cron: '0 7 * * *', agent: 'b' });

    expect(schedules.forAgent('a')).toEqual({
      clockId: 'sooner',
      cron: '0 8 * * *',
      prompt: 'Breakfast',
      enabled: true,
      nextRunAt: at(2026, 10, 10, 8).toISOString(),
      lastRun: null,
      hibernates: false,
    });
    clock.advanceTo(at(2026, 10, 10, 8));
    expect(schedules.forAgent('a')).toMatchObject({ clockId: 'later', nextRunAt: at(2026, 10, 10, 12).toISOString() });
    expect(schedules.forAgent('nobody')).toBeNull();
    expect(schedules.joinedTo('b')).toEqual(['other']);
  });

  it('tells clients when a clock is planned again or fires', () => {
    const { clock, changed, set } = scheduler();
    set('c', { cron: '0 8 * * *' });
    expect(changed).toEqual(['c']);
    clock.advanceTo(at(2026, 10, 10, 8));
    expect(changed).toEqual(['c', 'c']);
  });

  it('keeps clocks across restarts, firing from the next time after the restart', () => {
    const db = database();
    const first = scheduler({ db });
    first.set('c', { cron: '0 8 * * *' });
    first.schedules.close();

    const clock = createFakeClock(at(2026, 10, 11, 12));
    const second = scheduler({ db, clock });
    expect(second.schedules.status('c')).toMatchObject({ nextRunAt: at(2026, 10, 12, 8).toISOString() });
    clock.advanceTo(at(2026, 10, 12, 8));
    expect(second.runs).toHaveLength(1);
    expect(first.runs).toHaveLength(0);
  });

  it('never fires a clock that is off or not set: no prompt, no agent, or a fresh one with no zone', () => {
    const { clock, schedules, runs, set } = scheduler();
    set('off', { cron: '* * * * *', enabled: false });
    set('silent', { cron: '* * * * *', prompt: '  ' });
    set('unjoined', { cron: '* * * * *', agent: null });
    set('loose', { cron: '* * * * *', does: 'fresh', agent: null }, null);
    expect(schedules.statuses().map((status) => status.nextRunAt)).toEqual([null, null, null, null]);
    clock.advance(60 * 60_000);
    expect(runs).toEqual([]);
    expect(schedules.hasEnabled()).toBe(false);
  });

  it('starts a fresh agent with no agent joined, when it is in a zone', () => {
    const { clock, runs, set } = scheduler();
    set('c', { cron: '0 8 * * *', does: 'fresh', agent: null });
    clock.advanceTo(at(2026, 10, 10, 8));
    expect(runs).toEqual([{ clockId: 'c', agent: null, prompt: 'Sweep', at: at(2026, 10, 10, 8) }]);
  });

  it('skips a fire time while its last run is still going, and fires again once it is over', () => {
    const { clock, schedules, runs, set, answer } = scheduler();
    set('c', { cron: '0 * * * *', does: 'fresh', agent: null });
    let started: number | undefined;
    answer.next = { running: true, start: (runId) => (started = runId) };
    clock.advanceTo(at(2026, 10, 10, 8));
    const [running] = schedules.status('c')!.runs;
    expect(running).toMatchObject({ outcome: 'running' });
    expect(started).toBe(running!.id);
    const firedAt = at(2026, 10, 10, 8).toISOString();
    expect(schedules.running()).toEqual([{ runId: running!.id, clockId: 'c', fresh: true, firedAt, sessionId: null, result: null, flag: null, joins: false }]);
    schedules.updateRun(running!.id, { sessionId: 'fresh-1', agentName: 'Sweep #1' });
    expect(schedules.runOf('fresh-1')).toEqual({ runId: running!.id, clockId: 'c', fresh: true, firedAt, flag: null, joins: false });

    clock.advanceTo(at(2026, 10, 10, 9));
    expect(runs).toHaveLength(1);
    expect(schedules.status('c')!.runs[0]).toMatchObject({ outcome: 'skipped', reason: 'its last run is still going' });

    schedules.updateRun(running!.id, { outcome: 'done', result: 'All swept', finishedAt: at(2026, 10, 10, 9, 5).toISOString() });
    expect(schedules.runOf('fresh-1')).toBeUndefined();
    clock.advanceTo(at(2026, 10, 10, 10));
    expect(runs).toHaveLength(2);
    expect(schedules.status('c')!.runs.map((run) => run.outcome)).toEqual(['running', 'skipped', 'done']);
    expect(schedules.status('c')!.runs[2]).toMatchObject({ result: 'All swept', agentName: 'Sweep #1' });
  });

  it("keeps a message's run open until its turn ends, as started, and fails one whose turn never ended once the next fires", () => {
    const { clock, schedules, set, answer } = scheduler();
    set('c', { cron: '0 * * * *', hibernate: true });
    expect(schedules.forAgent('a')).toMatchObject({ hibernates: true });
    answer.next = { started: true, sessionId: 'a', agentName: 'Sweeper', awaitsTurn: true };
    clock.advanceTo(at(2026, 10, 10, 8));
    const [first] = schedules.status('c')!.runs;
    // Started, not running: a daemon from before this would close the agent of a running one as it starts up.
    expect(first).toMatchObject({ outcome: 'started', awaitsTurn: true, finishedAt: null, flag: null });
    expect(schedules.runOf('a')).toEqual({ runId: first!.id, clockId: 'c', fresh: false, firedAt: at(2026, 10, 10, 8).toISOString(), flag: null, joins: false });

    clock.advanceTo(at(2026, 10, 10, 9));
    const [second, earlier] = schedules.status('c')!.runs;
    expect(second).toMatchObject({ outcome: 'started', awaitsTurn: true });
    expect(earlier).toMatchObject({ outcome: 'failed', reason: 'its turn never ended before the next run', finishedAt: expect.any(String) });
    expect(schedules.runOf('a')?.runId).toBe(second!.id);

    schedules.updateRun(second!.id, { outcome: 'done', result: 'Nothing new', finishedAt: at(2026, 10, 10, 9, 2).toISOString(), flag: 'Sam asked about the release' });
    expect(schedules.runOf('a')).toBeUndefined();
    expect(schedules.status('c')!.runs[0]).toMatchObject({ outcome: 'done', result: 'Nothing new', flag: 'Sam asked about the release' });

    // One left unsent, or a turn not waited for, is over as it fires.
    answer.next = { started: true, sessionId: 'a', agentName: 'Sweeper' };
    clock.advanceTo(at(2026, 10, 10, 10));
    expect(schedules.status('c')!.runs[0]).toMatchObject({ outcome: 'started', awaitsTurn: false });
    expect(schedules.runOf('a')).toBeUndefined();
  });

  it('says whether any clock is planned, which keeps the daemon up', () => {
    const { schedules, set, remove } = scheduler();
    expect(schedules.hasEnabled()).toBe(false);
    set('c', { enabled: false });
    expect(schedules.hasEnabled()).toBe(false);
    set('c', { enabled: true });
    expect(schedules.hasEnabled()).toBe(true);
    remove('c');
    expect(schedules.hasEnabled()).toBe(false);
  });

  it('fires on time after the clock is set back, as when NTP corrects a fast clock', () => {
    // The clock runs a day fast when the schedule is set, so it plans the 09:00 of the wrong day.
    const { clock, schedules, runs, set } = scheduler({ clock: createFakeClock(at(2026, 10, 11, 7, 30)) });
    set('c', { cron: '0 9 * * *' });
    expect(schedules.status('c')!.nextRunAt).toBe(at(2026, 10, 11, 9).toISOString());

    clock.setBack(24 * 60 * 60_000);
    clock.advanceTo(at(2026, 10, 10, 9));
    expect(runs.map((run) => run.at)).toEqual([at(2026, 10, 10, 9)]);
    expect(schedules.status('c')!.nextRunAt).toBe(at(2026, 10, 11, 9).toISOString());
  });

  it("follows a change of time zone, firing at the new zone's wall-clock time", () => {
    const { clock, schedules, runs, set } = scheduler();
    set('c', { cron: '0 9 * * *' });
    try {
      // New York is five hours behind London: its 09:00 is London's 14:00.
      process.env.TZ = 'America/New_York';
      clock.advance(60_000);
      expect(schedules.status('c')!.nextRunAt).toBe(new Date(Date.UTC(2026, 9, 10, 13)).toISOString());
      clock.advanceTo(new Date(Date.UTC(2026, 9, 10, 13)));
      expect(runs.map((run) => run.at.toISOString())).toEqual([new Date(Date.UTC(2026, 9, 10, 13)).toISOString()]);
    } finally {
      process.env.TZ = 'Europe/London';
    }
  });

  it('fires once, late, for fire times the machine slept through, then carries on from then', () => {
    const { clock, schedules, runs, set } = scheduler();
    set('c', { cron: '0 * * * *' });

    clock.sleep(3 * 60 * 60_000 + 10 * 60_000); // wakes at 10:40:15
    expect(runs.map((run) => run.at)).toEqual([at(2026, 10, 10, 10, 40, 15)]);
    expect(schedules.status('c')).toMatchObject({
      nextRunAt: at(2026, 10, 10, 11).toISOString(),
      runs: [{ dueAt: at(2026, 10, 10, 8).toISOString(), firedAt: at(2026, 10, 10, 10, 40, 15).toISOString() }],
    });
  });

  it('follows a changed clock, and forgets a deleted one', () => {
    const { clock, schedules, runs, set, remove } = scheduler();
    set('c', { cron: '0 12 * * *', prompt: 'Old' });
    set('c', { cron: '0 8 * * *', prompt: 'New' });
    clock.advanceTo(at(2026, 10, 10, 12));
    expect(runs.map((run) => [run.prompt, run.at])).toEqual([['New', at(2026, 10, 10, 8)]]);

    remove('c');
    expect(schedules.status('c')).toBeNull();
    clock.advanceTo(at(2026, 10, 12));
    expect(runs).toHaveLength(1);
  });

  it('keeps a fire time when only where a clock is, or how it is drawn, changes: a drag as it falls due loses none', () => {
    const { db, clock, schedules, runs, answer, set } = scheduler();
    set('a', { cron: '0 8 * * *', prompt: 'A' });
    set('b', { cron: '0 8 * * *', prompt: 'B' });
    // As a fires, b is dragged and folded: its 08:00 is due, not yet fired.
    answer.during = (clockId) => {
      if (clockId !== 'a') return;
      db.prepare("UPDATE board_items SET x = 500, data = json_set(data, '$.folded', json('true')) WHERE id = 'b'").run();
      schedules.replan('b');
    };
    clock.advanceTo(at(2026, 10, 10, 8));
    expect(runs.map((run) => [run.prompt, run.at])).toEqual([
      ['A', at(2026, 10, 10, 8)],
      ['B', at(2026, 10, 10, 8)],
    ]);
  });

  it('runs each clock on its own schedule', () => {
    const { clock, runs, set } = scheduler();
    set('a', { cron: '0 8 * * *', prompt: 'A' });
    set('b', { cron: '45 7-8 * * *', prompt: 'B', agent: 'b' });
    clock.advanceTo(at(2026, 10, 10, 9));
    expect(runs.map((run) => [run.clockId, run.at])).toEqual([
      ['b', at(2026, 10, 10, 7, 45)],
      ['a', at(2026, 10, 10, 8)],
      ['b', at(2026, 10, 10, 8, 45)],
    ]);
  });

  it('stops firing once closed', () => {
    const { clock, schedules, runs, set } = scheduler();
    set('c', { cron: '* * * * *' });
    schedules.close();
    clock.advance(10 * 60_000);
    expect(runs).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});

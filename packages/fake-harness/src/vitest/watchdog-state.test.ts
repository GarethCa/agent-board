import { describe, expect, it } from 'vitest';
import { awakeClock, createState, limitFor, mark, overdue, publishAwake, WATCHDOG_FLOOR_MS } from './watchdog-state.ts';

describe('overdue', () => {
  it('is nothing while the current phase is within its limit', () => {
    const state = createState();
    mark(state, 'a.test.ts > adds', 1_000, 10_000);
    expect(overdue(state, 10_999)).toBeUndefined();
  });

  it('names the phase that ran past its limit, and for how long', () => {
    const state = createState();
    mark(state, 'a.test.ts > spins', 1_000, 10_000);
    expect(overdue(state, 11_500)).toEqual({ where: 'a.test.ts > spins', elapsedMs: 1_500, limitMs: 1_000 });
  });

  it('starts the clock again at each mark', () => {
    const state = createState();
    mark(state, 'a.test.ts > first', 1_000, 10_000);
    mark(state, 'a.test.ts > second', 1_000, 10_900);
    expect(overdue(state, 11_500)).toBeUndefined();
  });

  it('is nothing before the first mark', () => {
    expect(overdue(createState(), 1_000_000)).toBeUndefined();
  });

  it('stamps a phase with the awake time the watchdog last published', () => {
    const state = createState();
    publishAwake(state, 5_000);
    mark(state, 'a.test.ts > stamped', 1_000);
    expect(overdue(state, 6_000)).toBeUndefined();
    expect(overdue(state, 6_001)?.elapsedMs).toBe(1_001);
  });

  it('keeps a long name, cut to fit, without breaking a character', () => {
    const state = createState();
    mark(state, `${'é'.repeat(5_000)}`, 1, 0);
    const where = overdue(state, 10)!.where;
    expect(where.length).toBeGreaterThan(100);
    expect(where).toMatch(/^é+…$/);
  });
});

describe('limitFor', () => {
  it('gives a test three times its timeout, and never less than the floor', () => {
    expect(limitFor(20_000, {})).toBe(60_000);
    expect(limitFor(30_000, {})).toBe(90_000);
    expect(limitFor(5_000, {})).toBe(WATCHDOG_FLOOR_MS);
    expect(limitFor(undefined, {})).toBe(WATCHDOG_FLOOR_MS);
    expect(limitFor(0, {})).toBe(WATCHDOG_FLOOR_MS);
  });

  it('takes a fixed limit from TEST_WATCHDOG_MS', () => {
    expect(limitFor(20_000, { TEST_WATCHDOG_MS: '1500' })).toBe(1_500);
  });

  it('ignores a TEST_WATCHDOG_MS that is not a positive number', () => {
    expect(limitFor(20_000, { TEST_WATCHDOG_MS: 'soon' })).toBe(60_000);
    expect(limitFor(20_000, { TEST_WATCHDOG_MS: '0' })).toBe(60_000);
  });
});

describe('awakeClock', () => {
  /** A wall clock that returns `times` in turn, the first to the clock as it is made. */
  const wall = (...times: number[]) => () => times.shift()!;

  it('follows the wall clock while it ticks steadily', () => {
    const clock = awakeClock(wall(10_000, 10_000, 10_250, 10_500, 10_750), 1_000);
    expect([clock(), clock(), clock(), clock()]).toEqual([0, 250, 500, 750]);
  });

  it('counts a jump, as when the machine slept, as no more than the cap', () => {
    const clock = awakeClock(wall(10_000, 10_000, 10_250, 10_250 + 15 * 60_000, 10_250 + 15 * 60_000 + 250), 1_000);
    expect([clock(), clock(), clock(), clock()]).toEqual([0, 250, 1_250, 1_500]);
  });

  it('never goes back when the wall clock does', () => {
    const clock = awakeClock(wall(10_000, 10_000, 9_000, 9_250), 1_000);
    expect([clock(), clock(), clock()]).toEqual([0, 0, 250]);
  });

  it('keeps a phase from going overdue across a sleep', () => {
    const state = createState();
    const clock = awakeClock(wall(0, 0, 250, 250 + 15 * 60_000, 500 + 15 * 60_000), 1_000);
    publishAwake(state, clock());
    mark(state, 'a.test.ts > across a sleep', 60_000);
    for (let i = 0; i < 3; i++) expect(overdue(state, clock())).toBeUndefined();
  });
});

import type { Clock } from '../src/clock.ts';

export interface FakeClock extends Clock {
  /** Moves time on by `ms`, running each timer that falls due on the way, in order, at its own time. */
  advance(ms: number): void;
  /** Moves time on to `date`. */
  advanceTo(date: Date): void;
  /** Jumps time on by `ms` with no timer running on the way, as when the machine sleeps; overdue timers then run, late. */
  sleep(ms: number): void;
  /**
   * Sets the wall clock back by `ms`, as when NTP corrects a fast clock. Timers measure elapsed time, not the wall
   * clock, so each still runs after the same wait as before.
   */
  setBack(ms: number): void;
  /** Timers still waiting. */
  pending(): number;
}

/** A clock that only moves when told to, starting at `start`. */
export function createFakeClock(start: Date): FakeClock {
  let now = start.getTime();
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const advanceTo = (target: number, late = false) => {
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of timers) if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      if (due === undefined) break;
      timers.delete(due[0]);
      if (!late) now = Math.max(now, due[1].at);
      due[1].callback();
    }
    now = Math.max(now, target);
  };

  return {
    now: () => now,
    setTimer(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), callback });
      return () => timers.delete(id);
    },
    advance: (ms) => advanceTo(now + ms),
    advanceTo: (date) => advanceTo(date.getTime()),
    sleep(ms) {
      now += ms;
      advanceTo(now, true);
    },
    setBack(ms) {
      now -= ms;
      for (const timer of timers.values()) timer.at -= ms;
    },
    pending: () => timers.size,
  };
}

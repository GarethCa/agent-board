// Time for the scheduler, behind an interface so tests can drive it with a fake clock.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Calls `callback` once `ms` have passed. Returns a function that cancels it. */
  setTimer(callback: () => void, ms: number): () => void;
}

/** The real clock. Its timers don't keep the process alive on their own. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

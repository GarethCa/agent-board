// Leading-and-trailing throttle, for work that follows a drag (the terminal's refit while its window is resized): the
// first call runs at once, a burst after it folds into one more call when the interval is up, so the last state is
// always the one acted on. Pure apart from timers, so it is unit-tested with fake ones.

export interface Throttled {
  call(): void;
  /** Drops the call waiting, if any. */
  cancel(): void;
}

export function throttled(run: () => void, intervalMs: number): Throttled {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call() {
      if (timer !== undefined) return;
      const wait = last + intervalMs - Date.now();
      if (wait <= 0) {
        last = Date.now();
        run();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        run();
      }, wait);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

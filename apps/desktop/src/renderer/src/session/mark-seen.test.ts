import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttleTrailing } from './mark-seen';

describe('throttleTrailing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first call at once and a call inside the interval when it ends', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 1000);
    throttled.call();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    throttled.call();
    throttled.call();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(700);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs a call after the interval at once', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 1000);
    throttled.call();
    vi.advanceTimersByTime(1000);
    throttled.call();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('drops a held call when cancelled', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 1000);
    throttled.call();
    throttled.call();
    throttled.cancel();
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

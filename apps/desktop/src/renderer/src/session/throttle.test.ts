import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttled } from './throttle';

describe('a throttled call', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first call at once', () => {
    const run = vi.fn();
    throttled(run, 80).call();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('folds a burst into one more call, after the interval, so the last state is always acted on', () => {
    const run = vi.fn();
    const fit = throttled(run, 80);
    for (let i = 0; i < 10; i++) {
      fit.call();
      vi.advanceTimersByTime(5);
    }
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(80);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs a call that comes after the interval at once', () => {
    const run = vi.fn();
    const fit = throttled(run, 80);
    fit.call();
    vi.advanceTimersByTime(200);
    fit.call();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs at most about once per interval through a long drag', () => {
    const run = vi.fn();
    const fit = throttled(run, 80);
    for (let ms = 0; ms < 1000; ms += 16) {
      fit.call();
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(80);
    expect(run.mock.calls.length).toBeLessThanOrEqual(1000 / 80 + 2);
    expect(run.mock.calls.length).toBeGreaterThan(5);
  });

  it('drops the waiting call when cancelled', () => {
    const run = vi.fn();
    const fit = throttled(run, 80);
    fit.call();
    fit.call();
    fit.cancel();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

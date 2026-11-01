import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredValue } from '../stored-value';
import { lastLookClock, throttleTrailing } from './mark-seen';

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

describe('lastLookClock', () => {
  function memory(initial?: string): StoredValue & { value: string | undefined } {
    const store = { value: initial, get: () => store.value, set: (v: string | undefined) => void (store.value = v), subscribe: () => () => {} };
    return store;
  }

  it('is now for the first look ever, without storing it', () => {
    const store = memory();
    expect(lastLookClock(store, () => 5000).since()).toBe(5000);
    expect(store.value).toBeUndefined();
  });

  it('reads the stored look, and ignores a value that is not a time', () => {
    expect(lastLookClock(memory('1234'), () => 5000).since()).toBe(1234);
    expect(lastLookClock(memory('nonsense'), () => 5000).since()).toBe(5000);
    expect(lastLookClock(memory('-3'), () => 5000).since()).toBe(5000);
  });

  it('stamps now, which the next read finds', () => {
    let now = 1000;
    const store = memory('10');
    const clock = lastLookClock(store, () => now);
    now = 2000;
    clock.stamp();
    expect(store.value).toBe('2000');
    expect(clock.since()).toBe(2000);
  });
});

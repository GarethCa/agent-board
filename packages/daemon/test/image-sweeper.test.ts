import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageSweeper, referencedImages } from '../src/image-sweeper.ts';
import type { ImageStore } from '../src/image-store.ts';
import { migrate } from '../src/migrate.ts';

afterEach(() => vi.useRealTimers());

function setup(sweep: ImageStore['sweep']) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const store = { graceMs: 60_000, sweep: vi.fn(sweep) } as unknown as ImageStore;
  return { db, store, sweeper: createImageSweeper(db, store, () => {}) };
}

describe('referencedImages', () => {
  it('collects image items’ images and link cards’ favicons, and nothing else', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(
      referencedImages([{ data: JSON.stringify({ sha256: a, ext: 'png' }) }, { data: JSON.stringify({ url: 'https://x.test', favicon: { sha256: b } }) }, { data: '{}' }]),
    ).toEqual(new Set([a, b]));
  });
});

describe('createImageSweeper', () => {
  it('sweeps again once the grace is over when it spared a new image, so a deleted image does not linger', () => {
    vi.useFakeTimers();
    const { sweeper, store } = setup(() => ({ removed: 0, spared: 1 }));

    sweeper.sweep();
    expect(store.sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(59_000);
    expect(store.sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(store.sweep).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });

  it('stops following up once nothing is spared, and when stopped', () => {
    vi.useFakeTimers();
    const outcomes = [{ removed: 0, spared: 1 }, { removed: 1, spared: 0 }];
    const { sweeper, store } = setup(() => outcomes.shift() ?? { removed: 0, spared: 0 });

    sweeper.sweep();
    vi.advanceTimersByTime(61_000);
    vi.advanceTimersByTime(600_000);
    expect(store.sweep).toHaveBeenCalledTimes(2);

    const again = setup(() => ({ removed: 0, spared: 1 }));
    again.sweeper.sweep();
    again.sweeper.stop();
    vi.advanceTimersByTime(600_000);
    expect(again.store.sweep).toHaveBeenCalledTimes(1);
  });

  it('never throws: a sweep that fails is logged', () => {
    const log = vi.fn();
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const store = { graceMs: 0, sweep: () => { throw new Error('disk gone'); } } as unknown as ImageStore;
    expect(() => createImageSweeper(db, store, log).sweep()).not.toThrow();
    expect(log).toHaveBeenCalledWith('could not sweep unused images: disk gone');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderRefresher, insideWorktree, tildify } from './live-folder';

describe('the live folder refresher', () => {
  let visible = true;
  const fetch = vi.fn(async () => '/tmp');
  const seen: string[] = [];
  const make = () => createFolderRefresher({ fetch, onFolder: (folder) => seen.push(folder), visible: () => visible, debounceMs: 100, pollMs: 1_000 });

  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    fetch.mockClear();
    seen.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('looks the folder up once a burst of triggers has settled', async () => {
    const refresher = make();
    refresher.refresh();
    refresher.refresh();
    refresher.refresh();
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['/tmp']);
    refresher.stop();
  });

  it('polls lightly while started, and not once stopped', async () => {
    const refresher = make();
    refresher.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    refresher.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('never looks up while the window is hidden, and catches up when it shows again', async () => {
    const refresher = make();
    refresher.start();
    visible = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).not.toHaveBeenCalled();
    visible = true;
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it('drops an answer that arrives after it was stopped', async () => {
    const refresher = make();
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(100);
    refresher.refresh();
    refresher.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('tildify', () => {
  it('writes the home folder as ~', () => {
    expect(tildify('/Users/g', '/Users/g')).toBe('~');
    expect(tildify('/Users/g/code/x', '/Users/g')).toBe('~/code/x');
    expect(tildify('/Users/gx/code', '/Users/g')).toBe('/Users/gx/code');
    expect(tildify('/tmp', undefined)).toBe('/tmp');
  });
});

describe('insideWorktree', () => {
  it('is true for the worktree and what is under it, not for a sibling with the same prefix', () => {
    expect(insideWorktree('/w/a', '/w/a')).toBe(true);
    expect(insideWorktree('/w/a/src', '/w/a')).toBe(true);
    expect(insideWorktree('/w/ab', '/w/a')).toBe(false);
    expect(insideWorktree('/tmp', '/w/a')).toBe(false);
  });
});

// The library as menus read it: a read that fails is tried again, by one timer however many failed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';

const SOLO = { name: 'Solo agent', builtIn: true } as LibraryPrefab;

describe('the prefab store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps what it knew through a failed read, and reads again with one timer until one succeeds', async () => {
    const prefabs = vi.fn<() => Promise<{ prefabs: LibraryPrefab[] }>>().mockRejectedValue(new Error('the daemon is restarting'));
    vi.stubGlobal('window', { agentBoard: { orchestrators: { prefabs } } });
    const { currentPrefabs, refreshPrefabs } = await import('./prefab-store');

    await Promise.all([refreshPrefabs(), refreshPrefabs()]);
    expect(prefabs).toHaveBeenCalledTimes(2);
    expect(currentPrefabs()).toEqual([]);

    prefabs.mockResolvedValue({ prefabs: [SOLO] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(prefabs).toHaveBeenCalledTimes(3);
    expect(currentPrefabs()).toEqual([SOLO]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(prefabs).toHaveBeenCalledTimes(3);
  });
});

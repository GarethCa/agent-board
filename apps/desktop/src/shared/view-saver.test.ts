import { describe, expect, it, vi } from 'vitest';
import { flushViewSaves, viewSaver } from './view-saver';

/** A save the test settles by hand. */
function heldSet() {
  const settles: (() => void)[] = [];
  const set = vi.fn<(value: unknown) => Promise<void>>(() => new Promise<void>((resolve) => settles.push(resolve)));
  return { set, settle: () => settles.shift()!() };
}

/** Whether `promise` has settled, once the microtasks queued so far have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe('flushing a view saver', () => {
  it('sends the save waiting at once, not after the delay, and settles once the save has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { set, settle } = heldSet();
      const save = viewSaver(set, 200);
      save(1);
      save(2);
      const flushed = save.flush();
      expect(set.mock.calls).toEqual([[2]]);
      expect(await settled(flushed)).toBe(false);
      settle();
      expect(await settled(flushed)).toBe(true);
      // Sent, it is not sent again when the delay passes.
      vi.advanceTimersByTime(200);
      expect(set).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a save already on its way, and sends nothing when none is waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { set, settle } = heldSet();
      const save = viewSaver(set, 200);
      expect(await settled(save.flush())).toBe(true);
      save(1);
      vi.advanceTimersByTime(200);
      expect(set).toHaveBeenCalledTimes(1);
      const flushed = save.flush();
      expect(set).toHaveBeenCalledTimes(1);
      expect(await settled(flushed)).toBe(false);
      settle();
      expect(await settled(flushed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushViewSaves sends every saver’s waiting save at once, a failed one too, and leaves none waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const windows = vi.fn().mockResolvedValue(undefined);
      const viewport = vi.fn().mockRejectedValue(new Error('daemon gone'));
      const idle = vi.fn().mockResolvedValue(undefined);
      viewSaver(idle, 200);
      viewSaver(windows, 200)(['closed']);
      viewSaver(viewport, 200)({ zoom: 1 });
      await flushViewSaves();
      expect(windows.mock.calls).toEqual([[['closed']]]);
      expect(viewport.mock.calls).toEqual([[{ zoom: 1 }]]);
      expect(idle).not.toHaveBeenCalled();
      await flushViewSaves();
      expect(windows).toHaveBeenCalledTimes(1);
      expect(viewport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('viewSaver', () => {
  it('saves only the last value once calls stop for the delay, and shrugs off a failed save', async () => {
    vi.useFakeTimers();
    try {
      const set = vi.fn().mockRejectedValueOnce(new Error('daemon gone')).mockResolvedValue(null);
      const save = viewSaver(set, 100);
      save(1);
      vi.advanceTimersByTime(50);
      save(2);
      vi.advanceTimersByTime(99);
      expect(set).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(set.mock.calls).toEqual([[2]]);
      await Promise.resolve();
      save(3);
      vi.advanceTimersByTime(100);
      expect(set.mock.calls).toEqual([[2], [3]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

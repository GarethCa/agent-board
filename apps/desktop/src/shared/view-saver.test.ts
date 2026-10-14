import { describe, expect, it, vi } from 'vitest';
import { viewSaver } from './view-saver';

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

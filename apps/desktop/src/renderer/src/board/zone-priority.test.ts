import { describe, expect, it } from 'vitest';
import type { Zone } from '@agent-board/daemon/protocol';
import { priorityChip, zoneHold, zonePriority } from './zone-priority';

describe("a zone's priority chip", () => {
  it('says the priority, and while the zone is held, that it is, with why', () => {
    expect(priorityChip({ priority: 'low', usageHold: null })).toEqual({ text: 'Low', label: 'Priority: Low', title: 'Its priority, for the usage thresholds in Settings' });
    expect(priorityChip({ priority: 'low', usageHold: { reason: '5h at 86%, zone low priority', since: '2026-10-28T10:00:00Z' } })).toEqual({
      text: '⏳ Low · held',
      label: 'Priority: Low, held for usage',
      title: 'Held: 5h at 86%, zone low priority. Override from this menu',
    });
  });

  it('reads a zone from a daemon that keeps neither as Normal and not held', () => {
    const older = {} as Zone;
    expect(zonePriority(older)).toBe('normal');
    expect(zoneHold(older)).toBeNull();
    expect(priorityChip(older)).toMatchObject({ text: 'Normal', label: 'Priority: Normal' });
  });
});

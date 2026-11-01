import { describe, expect, it } from 'vitest';
import type { UsageReading } from '@agent-board/daemon/protocol';
import { usageIslandText, usageMeter } from './usage-view';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const when = (iso: string) => iso.slice(11, 16);

const reading = (fresh: Partial<UsageReading> = {}): UsageReading => ({
  fiveHour: { usedPercent: 72.4, remainingPercent: 27.6, resetsAt: '2026-10-28T14:00:00.000Z' },
  sevenDay: { usedPercent: 41, remainingPercent: 59, resetsAt: null },
  readAt: '2026-10-28T09:59:00.000Z',
  stale: false,
  ...fresh,
});

describe('the usage pill', () => {
  it('shows nothing before any reading', () => {
    expect(usageMeter({ fiveHour: null, sevenDay: null, readAt: null, stale: true }, NOW, when)).toBeUndefined();
  });

  it('shows each window the reading has, what is left and when it resets, and how old it is', () => {
    expect(usageMeter(reading(), NOW, when)).toEqual({
      windows: [
        { short: '5h', label: '5-hour window', name: '5-hour', figure: '5h', used: 72, left: 28, resets: 'resets 14:00', refills: 'refills 14:00' },
        { short: '7d', label: '7-day window', name: 'Weekly', figure: 'wk', used: 41, left: 59, resets: '', refills: '' },
      ],
      stale: false,
      hot: false,
      fresh: 'Read 1 min ago',
    });
  });

  it('draws attention at 80% of either window, unless the reading is stale', () => {
    expect(usageMeter(reading({ sevenDay: { usedPercent: 80, remainingPercent: 20, resetsAt: null } }), NOW, when)?.hot).toBe(true);
    expect(usageMeter(reading({ sevenDay: { usedPercent: 80, remainingPercent: 20, resetsAt: null }, stale: true }), NOW, when)?.hot).toBe(false);
  });

  it('goes stale by the clock too, before the daemon says so', () => {
    expect(usageMeter(reading({ readAt: '2026-10-28T09:40:00.000Z' }), NOW, when)).toMatchObject({ stale: true, hot: false, fresh: 'Stale: last read 20 min ago. Updates when an agent runs.' });
  });

  it('says a stale reading is stale, and how old', () => {
    expect(usageMeter(reading({ readAt: '2026-10-28T09:08:00.000Z', stale: true }), NOW, when)).toMatchObject({
      stale: true,
      fresh: 'Stale: last read 52 min ago. Updates when an agent runs.',
    });
    expect(usageMeter(reading({ readAt: '2026-10-28T07:55:00.000Z', stale: true }), NOW, when)?.fresh).toMatch(/last read 2 h 5 min ago/);
  });
});

describe('the usage island', () => {
  it('reads as figures: each window by its short name and use, joined by a dot', () => {
    expect(usageIslandText(usageMeter(reading(), NOW, when)!)).toBe('5h 72% · wk 41%');
    expect(usageIslandText(usageMeter(reading({ fiveHour: null }), NOW, when)!)).toBe('wk 41%');
    expect(usageIslandText(usageMeter(reading({ sevenDay: null, fiveHour: { usedPercent: 86.4, remainingPercent: 13.6, resetsAt: null } }), NOW, when)!)).toBe('5h 86%');
  });

  it('words a refill time for the popover, and says nothing when the reading has none', () => {
    const [five, seven] = usageMeter(reading(), NOW, when)!.windows;
    expect(five!.refills).toBe('refills 14:00');
    expect(seven!.refills).toBe('');
  });
});

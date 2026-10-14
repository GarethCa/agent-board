import { afterAll, describe, expect, it } from 'vitest';
import type { AgentSchedule } from '@agent-board/daemon/protocol';
import { clockBadge, previewCron, whenLabel } from './schedule';

// Set before any local-time date below is made (CI runs in UTC), not in beforeAll, which runs after describe blocks.
const savedTz = process.env.TZ;
process.env.TZ = 'Europe/London';
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

/** Saturday 10 October 2026, 07:30 local time. */
const NOW = new Date(2026, 9, 10, 7, 30);

const schedule = (fields: Partial<AgentSchedule> = {}): AgentSchedule => ({
  cron: '0 9 * * *',
  prompt: 'Check the build',
  enabled: true,
  nextRunAt: new Date(2026, 9, 10, 9, 0).toISOString(),
  lastRun: null,
  ...fields,
});

describe('whenLabel', () => {
  it('says the time today, "tomorrow", the weekday within a week, else the date', () => {
    expect(whenLabel(new Date(2026, 9, 10, 9, 5), NOW)).toBe('09:05');
    expect(whenLabel(new Date(2026, 9, 11, 0, 0), NOW)).toBe('tomorrow 00:00');
    expect(whenLabel(new Date(2026, 9, 16, 18, 30), NOW)).toBe('Fri 18:30');
    expect(whenLabel(new Date(2026, 9, 17, 9, 0), NOW)).toBe('17 Oct 09:00');
    expect(whenLabel(new Date(2027, 0, 1, 0, 0), NOW)).toBe('1 Jan 2027 00:00');
  });
});

describe('clockBadge', () => {
  it('shows the next run, and the last run in its title', () => {
    expect(clockBadge(schedule(), false, NOW)).toEqual({
      label: '09:00',
      title: 'Next run 09:00 (0 9 * * *): Check the build',
    });
    const skipped = schedule({
      lastRun: { dueAt: '2026-10-09T08:00:00.000Z', firedAt: '2026-10-09T08:00:00.000Z', outcome: 'skipped', reason: 'it was still working' },
    });
    expect(clockBadge(skipped, false, NOW).title).toBe(
      'Next run 09:00 (0 9 * * *): Check the build\nLast run Fri 09:00 skipped: it was still working',
    );
  });

  it('says paused when disabled', () => {
    expect(clockBadge(schedule({ enabled: false, nextRunAt: null }), false, NOW).label).toBe('paused');
  });

  it("says an ended agent's next run relaunches it", () => {
    expect(clockBadge(schedule(), true, NOW)).toEqual({
      label: '09:00',
      title: 'Next run 09:00 relaunches it (0 9 * * *): Check the build',
    });
  });
});

describe('previewCron', () => {
  it('gives the next runs of an expression, or why it is no good', () => {
    expect(previewCron('0 9 * * 1-5', NOW)).toEqual({ next: [new Date(2026, 9, 12, 9), new Date(2026, 9, 13, 9), new Date(2026, 9, 14, 9)] });
    expect(previewCron('0 25 * * *', NOW)).toEqual({ error: expect.stringContaining('hour') });
  });
});

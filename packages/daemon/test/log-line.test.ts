import { describe, expect, it } from 'vitest';
import { logLine } from '../src/log-line.ts';
import { pinTimeZone } from './pin-time-zone.ts';

pinTimeZone('Europe/London');

describe('logLine', () => {
  it('starts each daemon log line with its local time and offset, to the millisecond', () => {
    expect(logLine('clock c fired: started a run', new Date(2026, 10, 1, 16, 0, 3, 120))).toBe(
      '2026-11-01T16:00:03.120+00:00 [agent-board daemon] clock c fired: started a run',
    );
    // Summer time.
    expect(logLine('up', new Date(2026, 6, 4, 9, 5, 0, 7))).toBe('2026-07-04T09:05:00.007+01:00 [agent-board daemon] up');
  });
});

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { followSystemTimeZone } from '../src/time-zone.ts';

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('followSystemTimeZone', () => {
  it("moves the daemon's local time to the system's new time zone", async () => {
    delete process.env.TZ;
    let zone = 'Europe/London';
    const stop = followSystemTimeZone({ intervalMs: 5, readZone: () => zone, log: () => {} });
    try {
      await sleep(20);
      expect(process.env.TZ).toBeUndefined();
      zone = 'America/New_York';
      await sleep(20);
      expect(process.env.TZ).toBe('America/New_York');
      expect(new Date(Date.UTC(2026, 9, 10, 13)).getHours()).toBe(9);
    } finally {
      stop();
    }
  });

  it('keeps a time zone the daemon was started with', async () => {
    process.env.TZ = 'Asia/Tokyo';
    const stop = followSystemTimeZone({ intervalMs: 5, readZone: () => 'America/New_York', log: () => {} });
    await sleep(20);
    stop();
    expect(process.env.TZ).toBe('Asia/Tokyo');
  });
});

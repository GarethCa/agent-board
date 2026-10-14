import { afterAll } from 'vitest';

/**
 * Runs the calling test file in `zone`, whatever the machine's own (CI runs in UTC). Call it at the top of the file,
 * before any local-time date is made: dates made in a describe block or an `it.each` table exist before `beforeAll`
 * runs. Restores the previous zone once the file's tests are done.
 */
export function pinTimeZone(zone: string): void {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

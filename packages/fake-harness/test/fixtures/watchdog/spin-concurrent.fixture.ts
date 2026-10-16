// Concurrent tests, one stuck in a synchronous loop, for test/watchdog.test.ts. Not a *.test.ts: it must never run in the suite.
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'vitest';

describe.concurrent('together', () => {
  test('spins', async () => {
    await sleep(50);
    writeFileSync(process.env.WATCHDOG_PID_FILE!, String(process.pid));
    while (true) { /* spin */ }
  });

  test('finishes', () => {});
});

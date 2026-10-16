// A test stuck in a synchronous loop, for test/watchdog.test.ts. Not a *.test.ts: it must never run in the suite.
import { writeFileSync } from 'node:fs';
import { describe, test } from 'vitest';

describe('a loop', () => {
  test('that finishes', () => {});

  test('that never ends', () => {
    // Tells the test which process to watch.
    writeFileSync(process.env.WATCHDOG_PID_FILE!, String(process.pid));
    while (true) { /* spin */ }
  });
});

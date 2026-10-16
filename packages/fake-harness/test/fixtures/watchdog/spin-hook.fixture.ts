// A describe-level beforeAll stuck in a synchronous loop, for test/watchdog.test.ts. Not a *.test.ts: it must never run in the suite.
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, test } from 'vitest';

describe('outer', () => {
  test('first', () => {});

  describe('inner', () => {
    beforeAll(() => {
      writeFileSync(process.env.WATCHDOG_PID_FILE!, String(process.pid));
      while (true) { /* spin */ }
    });

    test('never reached', () => {});
  });
});

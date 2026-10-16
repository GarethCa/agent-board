// A test file stuck in a synchronous loop while it loads, for test/watchdog.test.ts. Not a *.test.ts: it must never run in the suite.
import { writeFileSync } from 'node:fs';
import { test } from 'vitest';

writeFileSync(process.env.WATCHDOG_PID_FILE!, String(process.pid));
while (true) { /* spin */ }

test('never collected', () => {});

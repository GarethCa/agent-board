// A test that waits a long time without blocking, for test/watchdog.test.ts. Not a *.test.ts: it must never run in the suite.
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'vitest';

test('waits a minute', { timeout: 120_000 }, async () => {
  // Tells the test what to check after: the run's data dir, its main process, and this fork, written last.
  writeFileSync(`${process.env.WATCHDOG_PID_FILE}.run`, JSON.stringify({ dataDir: process.env.AGENT_BOARD_DATA_DIR, main: process.ppid }));
  writeFileSync(process.env.WATCHDOG_PID_FILE!, String(process.pid));
  await sleep(60_000);
});

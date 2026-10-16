// The config test/watchdog.test.ts runs its fixtures with: the suite's guards, the watchdog among them, and the one
// fixture named by WATCHDOG_FIXTURE.
import { defineConfig } from 'vitest/config';
import { GUARDS } from '../../../../../vitest.shared.ts';

export default defineConfig({
  test: { ...GUARDS, include: [`${process.env.WATCHDOG_FIXTURE}.fixture.ts`], testTimeout: 1_000 },
});

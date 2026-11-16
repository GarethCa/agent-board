import { configDefaults, defineConfig } from 'vitest/config';
import { GUARDS, PROCESS_TEST_TIMEOUT_MS, workerCounts, workerSettings } from './vitest.shared.ts';

const counts = workerCounts();

/** The release's leak rules run in the unit project, so a branch's own tests fail on them before the release does. */
const LEAK_RULES_TEST = 'scripts/release-public/leak-rules.test.ts';

/**
 * The daemon as a server, run by its clients: its socket, sends to agents, terminals with several viewers, and the
 * devices' door. The gate runs it alone for a daemon change (`scripts/check-pr/select.ts`); `pnpm test` runs it with the rest.
 */
const SERVER_SUITE = ['packages/daemon/test/server/**/*.test.ts', 'packages/daemon/test/remote/**/*.test.ts'];

export default defineConfig({
  test: {
    // Tests must never reach the real claude/codex (packages/fake-harness/src/guard.ts) or a real tracker.
    ...GUARDS,
    projects: [
      { extends: true, test: { name: 'unit', include: ['apps/*/{src,test}/**/*.test.ts', 'packages/*/src/**/*.test.ts', LEAK_RULES_TEST], ...workerSettings(counts, 'unit') } },
      {
        extends: true,
        test: {
          name: 'processes',
          include: ['packages/*/test/**/*.test.ts', 'scripts/*/**/*.test.ts'],
          exclude: [...configDefaults.exclude, LEAK_RULES_TEST, ...SERVER_SUITE],
          testTimeout: PROCESS_TEST_TIMEOUT_MS,
          ...workerSettings(counts, 'processes'),
        },
      },
      // Its tests run real processes, as the processes project's do, so it shares that project's workers and turn.
      { extends: true, test: { name: 'server', include: SERVER_SUITE, testTimeout: PROCESS_TEST_TIMEOUT_MS, ...workerSettings(counts, 'processes') } },
    ],
  },
});

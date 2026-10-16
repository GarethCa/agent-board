import { defineConfig } from 'vitest/config';
import { GUARDS, PROCESS_TEST_TIMEOUT_MS, workerCounts, workerSettings } from './vitest.shared.ts';

const counts = workerCounts();

export default defineConfig({
  test: {
    // Tests must never reach the real claude/codex (packages/fake-harness/src/guard.ts) or a real tracker.
    ...GUARDS,
    projects: [
      { extends: true, test: { name: 'unit', include: ['apps/*/{src,test}/**/*.test.ts', 'packages/*/src/**/*.test.ts'], ...workerSettings(counts, 'unit') } },
      {
        extends: true,
        test: {
          name: 'processes',
          include: ['packages/*/test/**/*.test.ts', 'scripts/*/**/*.test.ts'],
          testTimeout: PROCESS_TEST_TIMEOUT_MS,
          ...workerSettings(counts, 'processes'),
        },
      },
    ],
  },
});

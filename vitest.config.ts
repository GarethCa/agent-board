import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests must never reach the real claude/codex (packages/fake-harness/src/guard.ts) or a real tracker.
    globalSetup: ['packages/fake-harness/src/vitest/global-setup.ts'],
    setupFiles: ['packages/fake-harness/src/vitest/setup.ts', 'packages/tracker/src/vitest/setup.ts'],
    projects: [
      { extends: true, test: { name: 'unit', include: ['apps/*/{src,test}/**/*.test.ts', 'packages/*/src/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'processes',
          include: ['packages/*/test/**/*.test.ts', 'scripts/*/**/*.test.ts'],
          // These run real processes: a daemon, git, the fake harnesses and a hook forwarder per hook. Alone one takes up
          // to about 1.5 s, but with the suite and other checks loading the machine it can take several times that
          //, so the 5 s a unit test gets is not enough.
          testTimeout: 20_000,
        },
      },
    ],
  },
});

import { execFileSync } from 'node:child_process';
import { cpus, loadavg, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { chooseWorkers, type WorkerCounts } from './scripts/vitest-workers/workers.ts';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The guards every Vitest run loads, wherever it starts: tests must never reach the real claude/codex, git's own repo,
 * a real tracker or an enclosing board (packages/fake-harness/src/guard.ts, git-guard.ts, board-guard.ts,
 * packages/tracker/src/vitest/setup.ts), and a test stuck in a loop or a run whose starter is gone must not spin on
 * (the runner packages/fake-harness/src/vitest/watchdog.ts, and reap.ts). Absolute paths, so a package's own config can use them too.
 */
export const GUARDS = {
  globalSetup: [at('./packages/fake-harness/src/vitest/global-setup.ts'), at('./scripts/vitest-workers/announce.ts')],
  setupFiles: [at('./packages/fake-harness/src/vitest/setup.ts'), at('./packages/tracker/src/vitest/setup.ts')],
  runner: at('./packages/fake-harness/src/vitest/watchdog.ts'),
};

/**
 * Tests that run real processes: a daemon, git, the fake harnesses and a hook forwarder per hook. Alone one takes up
 * to about 1.5 s, but with the suite and other checks loading the machine it can take several times that, so
 * the 5 s a unit test gets is not enough.
 */
export const PROCESS_TEST_TIMEOUT_MS = 20_000;

/**
 * A package's own config, for `pnpm exec vitest` started in its folder: Vitest doesn't look above its folder for a
 * config, so without one that run would skip the guards.
 */
export function packageConfig(): ViteUserConfig {
  const counts = workerCounts();
  return defineConfig({
    test: {
      ...GUARDS,
      projects: [
        { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], ...workerSettings(counts, 'unit') } },
        { extends: true, test: {
          name: 'processes',
          include: ['test/**/*.test.ts'],
          testTimeout: PROCESS_TEST_TIMEOUT_MS,
          ...workerSettings(counts, 'processes'),
        },
      },
      ],
    },
  });
}

/**
 * The user's running processes and the per-user limit (`ulimit -u`), or null where they don't measure the same thing:
 * macOS counts processes against the limit, but Linux's RLIMIT_NPROC counts threads, which `ps` doesn't list.
 */
function processHeadroom(): { processCount: number | null; processLimit: number | null } {
  if (process.platform !== 'darwin') return { processCount: null, processLimit: null };
  try {
    const ps = execFileSync('ps', ['-U', String(userInfo().uid), '-o', 'pid='], { encoding: 'utf8', timeout: 3000 });
    const limit = Number(execFileSync('/bin/sh', ['-c', 'ulimit -u'], { encoding: 'utf8', timeout: 3000 }).trim());
    return {
      processCount: ps.split('\n').filter((line) => line.trim() !== '').length,
      processLimit: Number.isFinite(limit) ? limit : null,
    };
  } catch {
    return { processCount: null, processLimit: null };
  }
}

/**
 * Worker counts for this run, chosen from the cores, load and process headroom: the `processes` project's
 * workers each spawn a daemon, fakes and git, and about cores - 1 of them hit macOS's per-user process limit. Set
 * AGENT_BOARD_VITEST_WORKERS to force a count. The first config load picks them and hands them to the later loads
 * (package configs, workers) and to announce.ts, which prints them, in the environment, so `ps` runs once per run.
 */
export function workerCounts(): WorkerCounts {
  const chosen = process.env.AGENT_BOARD_VITEST_CHOSEN;
  if (chosen) return JSON.parse(chosen) as WorkerCounts;
  const counts = chooseWorkers({
    cores: cpus().length,
    load: loadavg()[0] ?? Number.NaN,
    ...processHeadroom(),
    override: process.env.AGENT_BOARD_VITEST_WORKERS,
  });
  process.env.AGENT_BOARD_VITEST_CHOSEN = JSON.stringify(counts);
  return counts;
}

/**
 * A project's worker cap, and why (for announce.ts, which prints once the config has loaded; knip and others stay quiet).
 * Each project gets its own `sequence.groupOrder`: Vitest refuses to start when two projects with different
 * `maxWorkers` share one, and the counts differ whenever the load is low.
 */
export const workerSettings = (counts: WorkerCounts, project: 'unit' | 'processes') => ({
  maxWorkers: counts[project],
  sequence: { groupOrder: project === 'unit' ? 0 : 1 },
  env: { AGENT_BOARD_VITEST_WHY: counts.why },
});

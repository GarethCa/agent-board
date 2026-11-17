/**
 * Vitest globalSetup: no `AGENT_BOARD_*` from an enclosing board, a throwaway app-data dir and home, tripwires first on
 * PATH for every worker, git kept off this checkout's repo, and the user's live launchers left alone; fail the run if a guard was hit. Also reaps this worktree's stale
 * runs and stops this one if whatever started it goes (reap.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubBoardEnv } from '../board-guard.ts';
import { compileCacheGlobalSetup } from '../compile-cache.ts';
import { gitGuardGlobalSetup } from '../git-guard.ts';
import { harnessGuardGlobalSetup } from '../guard.ts';
import { useTempHome } from '../home-guard.ts';
import { shimGuardGlobalSetup } from '../shim-guard.ts';
import { runEveryTeardown } from '../teardowns.ts';
import { reapStaleRuns, registerRun, stopWhenOrphaned } from './reap.ts';

export default async function globalSetup(): Promise<() => void> {
  await reapStaleRuns();
  const unregister = registerRun();
  scrubBoardEnv();
  compileCacheGlobalSetup();
  // With no AGENT_BOARD_SOCKET, the `agent-board` CLI and MCP fall back to the daemon of $AGENT_BOARD_DATA_DIR, else
  // the real app's: a test that forgets to point them at its own daemon must find none, not the live board.
  const dataDir = mkdtempSync(join(tmpdir(), 'ab-vitest-data-'));
  process.env.AGENT_BOARD_DATA_DIR = dataDir;
  const teardownHarness = harnessGuardGlobalSetup();
  const teardownGit = gitGuardGlobalSetup();
  const teardownShims = shimGuardGlobalSetup();
  // The real home's ~/.claude and ~/.codex hold the live app's hooks: a fake harness that read them would post to the
  // user's own board. Every test process, and all it starts, inherits this temp home instead (the fakes refuse the real one).
  const { restore: restoreHome } = useTempHome();
  const teardown = (): void => {
    try {
      runEveryTeardown([restoreHome, teardownShims, teardownGit, teardownHarness]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      unregister();
    }
  };
  const stopWatching = stopWhenOrphaned(teardown);
  return () => {
    stopWatching();
    teardown();
  };
}

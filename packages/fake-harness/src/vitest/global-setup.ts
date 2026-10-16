/**
 * Vitest globalSetup: no `AGENT_BOARD_*` from an enclosing board, a throwaway app-data dir, tripwires first on PATH for
 * every worker, and git kept off the dev repo; fail the run if either guard was hit. Also reaps this worktree's stale
 * runs and stops this one if whatever started it goes (reap.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubBoardEnv } from '../board-guard.ts';
import { gitGuardGlobalSetup } from '../git-guard.ts';
import { harnessGuardGlobalSetup } from '../guard.ts';
import { reapStaleRuns, registerRun, stopWhenOrphaned } from './reap.ts';

export default async function globalSetup(): Promise<() => void> {
  await reapStaleRuns();
  const unregister = registerRun();
  scrubBoardEnv();
  // With no AGENT_BOARD_SOCKET, the `agent-board` CLI and MCP fall back to the daemon of $AGENT_BOARD_DATA_DIR, else
  // the real app's: a test that forgets to point them at its own daemon must find none, not the live board.
  const dataDir = mkdtempSync(join(tmpdir(), 'ab-vitest-data-'));
  process.env.AGENT_BOARD_DATA_DIR = dataDir;
  const teardownHarness = harnessGuardGlobalSetup();
  const teardownGit = gitGuardGlobalSetup();
  const teardown = (): void => {
    try {
      teardownGit();
    } finally {
      try {
        teardownHarness();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
        unregister();
      }
    }
  };
  const stopWatching = stopWhenOrphaned(teardown);
  return () => {
    stopWatching();
    teardown();
  };
}

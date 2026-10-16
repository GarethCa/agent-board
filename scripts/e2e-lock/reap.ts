/**
 * Reaping the test Electron processes a worktree's e2e run left behind. Only processes whose executable lives under
 * this worktree's own `node_modules` count, so the real app and other worktrees' runs are never touched.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { killAll, leftovers, listProcesses, type ProcessInfo } from '../../packages/fake-harness/src/processes.ts';

/**
 * The Electron processes (the app, its helpers, and the daemons that run on the same executable) from `root`'s
 * `node_modules` that are orphans (parent is launchd/init) or descend from `ancestor`, the process that ran the tests.
 */
export function electronLeftovers(processes: readonly ProcessInfo[], root: string, ancestor?: number): ProcessInfo[] {
  const prefix = `${join(root, 'node_modules')}/`;
  return leftovers(processes, (p) => p.command.startsWith(prefix) && p.command.includes('/electron/dist/'), ancestor);
}

/** Reaps this worktree's leftover test Electron processes; `ancestor` also covers the live descendants of the run that just ended. */
export async function reapWorktree(root: string, ancestor?: number): Promise<number[]> {
  return killAll(electronLeftovers(listProcesses(), realpathSync(root), ancestor));
}

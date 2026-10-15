/**
 * Reaping the test Electron processes a worktree's e2e run left behind. Only processes whose executable lives under
 * this worktree's own `node_modules` count, so the real app and other worktrees' runs are never touched.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

export function parsePs(listing: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match !== null) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return processes;
}

/**
 * The Electron processes (the app, its helpers, and the daemons that run on the same executable) from `root`'s
 * `node_modules` that are orphans (parent is launchd/init) or descend from `ancestor`, the process that ran the tests.
 */
export function leftovers(processes: readonly ProcessInfo[], root: string, ancestor?: number): ProcessInfo[] {
  const prefix = `${join(root, 'node_modules')}/`;
  const parentOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const descends = (pid: number): boolean => {
    for (let at = parentOf.get(pid), hops = 0; at !== undefined && at > 1 && hops < 64; at = parentOf.get(at), hops++) {
      if (at === ancestor) return true;
    }
    return false;
  };
  const ours = (p: ProcessInfo): boolean => p.command.startsWith(prefix) && p.command.includes('/electron/dist/');
  const found = new Map(processes.filter((p) => ours(p) && (p.ppid === 1 || (ancestor !== undefined && descends(p.pid)))).map((p) => [p.pid, p]));
  // The helpers of an orphaned app are its children, not orphans themselves.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of processes) if (!found.has(p.pid) && ours(p) && found.has(p.ppid)) { found.set(p.pid, p); grew = true; }
  }
  return [...found.values()].sort((x, y) => x.pid - y.pid);
}

/** Kills `found` with SIGTERM, then SIGKILL for any that outlive `graceMs`. Returns the pids it signalled. */
export async function killAll(found: readonly ProcessInfo[], graceMs = 3_000): Promise<number[]> {
  const pids = found.map((p) => p.pid);
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch { /* gone already */ }
  for (let waited = 0; pids.some(alive) && waited < graceMs; waited += 100) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
  return pids;
}

/** Reaps this worktree's leftover test Electron processes; `ancestor` also covers the live descendants of the run that just ended. */
export async function reapWorktree(root: string, ancestor?: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return killAll(leftovers(parsePs(listing), realpathSync(root), ancestor));
}

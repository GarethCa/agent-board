/**
 * The process table, for the reapers and guards that keep test runs from outliving what started them: the e2e lock's
 * Electron reaper (scripts/e2e-lock/reap.ts), the Vitest reaper and orphan guard (src/vitest/), and the gate's stage
 * deadline (scripts/deadline). Unix only: on Windows the listing is empty.
 */
import { execFileSync } from 'node:child_process';

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

/** Every process on the machine, from `ps`. */
export function listProcesses(): ProcessInfo[] {
  if (process.platform === 'win32') return [];
  return parsePs(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Each process's group and start time (as `ps` prints it; the same process always gives the same one), by pid. */
export function processDetails(): Map<number, { pgid: number; started: string }> {
  const details = new Map<number, { pgid: number; started: string }>();
  if (process.platform === 'win32') return details;
  const listing = execFileSync('ps', ['-axo', 'pid=,pgid=,lstart='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (match !== null) details.set(Number(match[1]), { pgid: Number(match[2]), started: match[3]! });
  }
  return details;
}

/** Whether `pid` is still running (or a zombie not yet reaped by its parent). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pids above `pid`, its parent first, up to but not including launchd/init (pid 1). */
export function ancestry(processes: readonly ProcessInfo[], pid: number): number[] {
  const parentOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const chain: number[] = [];
  for (let at = parentOf.get(pid); at !== undefined && at > 1 && chain.length < 64; at = parentOf.get(at)) chain.push(at);
  return chain;
}

/** Every process below `pid`, children first. */
export function descendants(processes: readonly ProcessInfo[], pid: number): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  const below = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of processes) if (!below.has(p.pid) && below.has(p.ppid)) { below.add(p.pid); found.push(p); grew = true; }
  }
  return found;
}

/**
 * Calls `onGone` once, with its pid, when a process above this one exits: whatever started this one (a shell an agent's
 * tool timed out and killed, a closed pane) is gone, and nothing will read its output. A process reparented to
 * launchd/init counts too, as its parent is gone. Returns a function that stops watching. Never keeps the process alive.
 */
export function watchAncestors(onGone: (pid: number) => void, intervalMs = 1_000): () => void {
  const chain = ancestry(listProcesses(), process.pid);
  const parent = process.ppid;
  const timer = setInterval(() => {
    const gone = process.ppid !== parent ? parent : chain.find((pid) => !alive(pid));
    if (gone === undefined) return;
    clearInterval(timer);
    onGone(gone);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The processes `ours` picks that are orphans (parent is launchd/init) or descend from `ancestor`, plus their own
 * descendants that `ours` picks: what a run left behind once whatever started it is gone.
 */
export function leftovers(processes: readonly ProcessInfo[], ours: (p: ProcessInfo) => boolean, ancestor?: number): ProcessInfo[] {
  const descends = (pid: number): boolean => ancestor !== undefined && ancestry(processes, pid).includes(ancestor);
  const found = new Map(processes.filter((p) => ours(p) && (p.ppid === 1 || descends(p.pid))).map((p) => [p.pid, p]));
  // The children of an orphan are not orphans themselves.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of processes) if (!found.has(p.pid) && ours(p) && found.has(p.ppid)) { found.set(p.pid, p); grew = true; }
  }
  return [...found.values()].sort((x, y) => x.pid - y.pid);
}

/** Kills `found` with SIGTERM, then SIGKILL for any that outlive `graceMs`. Returns the pids it signalled. */
export async function killAll(found: readonly ProcessInfo[], graceMs = 3_000): Promise<number[]> {
  const pids = found.map((p) => p.pid);
  for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch { /* gone already */ }
  for (let waited = 0; pids.some(alive) && waited < graceMs; waited += 100) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
  return pids;
}

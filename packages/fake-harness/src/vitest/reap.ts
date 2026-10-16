/**
 * The guards that keep a Vitest run from outliving what started it: the run stops when its starter is gone,
 * and each run first reaps the stale runs of its own worktree that an earlier, killed starter left spinning.
 *
 * The reaper only touches what a run of this worktree registered: each run records its main process, that process's
 * start time and its process group in a registry for as long as it runs. A run is stale only when its main process has
 * exited (no process has its pid and start time) or is orphaned; whether a run is live never depends on its command
 * line, which `pnpm exec` gives a relative path. From a stale run, a process is reaped only if it is `node` running this
 * worktree's Vitest CLI or fork worker, is in the run's group, and is an orphan or below its (still running) main
 * process. A `claude` session, a pager or a shell whose command line merely names those paths, a live run, another
 * worktree's run and the reaper's own ancestors are never touched.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestry, descendants, killAll, listProcesses, processDetails, watchAncestors, type ProcessInfo } from '../processes.ts';

/** This worktree (or checkout): the processes run from its `node_modules` are its own. */
const ROOT = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
/** One file per live run, named by its main process's pid. */
const REGISTRY = join(tmpdir(), 'agent-board-vitest-runs');

/** A registered run: its worktree, its main process, that process's group and its start time (`ps` lstart). */
export interface RunRecord {
  root: string;
  pid: number;
  pgid: number;
  started: string;
}

type Details = ReadonlyMap<number, { pgid: number; started: string }>;

/** Whether `run`'s main process is still the process with its pid: same start time. */
const running = (run: RunRecord, details: Details): boolean => details.get(run.pid)?.started === run.started;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `command` is `node` running, as a whole argument, `root`'s Vitest CLI (`vitest.mjs`, through the `.bin`
 * link or not) or Vitest's fork worker entry.
 */
export function isVitestProcess(command: string, root: string): boolean {
  const modules = `${escape(root.replace(/\/$/, ''))}/node_modules`;
  const entry = `${modules}/(?:\\.bin/\\.\\./vitest/vitest\\.mjs|vitest/vitest\\.mjs|\\.pnpm/vitest@[^/\\s]+/node_modules/vitest/(?:vitest\\.mjs|dist/workers/forks\\.js))`;
  return new RegExp(`^(?:\\S*/)?node\\s(?:.*\\s)?${entry}(?:\\s|$)`).test(command);
}

/**
 * The processes to reap: for each of `root`'s registered `runs` whose main process has exited or is orphaned, the
 * Vitest processes in its group that are orphans or below that main process. Never `self` or its ancestors.
 */
export function staleRunProcesses(
  processes: readonly ProcessInfo[],
  details: Details,
  runs: readonly RunRecord[],
  root: string,
  self = process.pid,
): ProcessInfo[] {
  const spared = new Set([self, ...ancestry(processes, self)]);
  const found = new Map<number, ProcessInfo>();
  for (const run of runs) {
    if (run.root !== root) continue;
    // A main that is still its run's: live unless orphaned. Otherwise its pid, if taken, is another process's now.
    const main = running(run, details) ? processes.find((p) => p.pid === run.pid) : undefined;
    if (main !== undefined && main.ppid !== 1) continue;
    for (const p of processes) {
      if (spared.has(p.pid) || details.get(p.pid)?.pgid !== run.pgid || !isVitestProcess(p.command, root)) continue;
      if (p.ppid === 1 || (main !== undefined && ancestry(processes, p.pid).includes(main.pid))) found.set(p.pid, p);
    }
  }
  return [...found.values()].sort((x, y) => x.pid - y.pid);
}

/** The records, of any worktree, whose main process has exited: nothing will remove them but the reaper. */
export function goneRuns(runs: readonly RunRecord[], details: Details): RunRecord[] {
  return runs.filter((run) => !running(run, details));
}

function readRuns(): RunRecord[] {
  let names: string[];
  try { names = readdirSync(REGISTRY); } catch { return []; }
  return names.flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(REGISTRY, name), 'utf8')) as RunRecord]; } catch { return []; }
  });
}

/** Kills this worktree's stale Vitest runs and forgets every run whose main process has exited; returns the pids it signalled. */
export async function reapStaleRuns(root = ROOT): Promise<number[]> {
  const runs = readRuns();
  const details = processDetails();
  const reaped = await killAll(staleRunProcesses(listProcesses(), details, runs, root));
  for (const run of goneRuns(runs, details)) rmSync(join(REGISTRY, `${run.pid}.json`), { force: true });
  return reaped;
}

/** Registers this run for the reaper; returns a function that unregisters it. */
export function registerRun(root = ROOT): () => void {
  const self = processDetails().get(process.pid);
  if (self === undefined) return () => {};
  const file = join(REGISTRY, `${process.pid}.json`);
  mkdirSync(REGISTRY, { recursive: true });
  writeFileSync(file, JSON.stringify({ root, pid: process.pid, ...self } satisfies RunRecord));
  return () => rmSync(file, { force: true });
}

/**
 * Stops this run, and everything it started, once a process above it is gone: an agent's shell its tool timed out and
 * killed, a pane closed under it. Its forks would otherwise spin on as orphans. `cleanup` (the run's teardown) runs
 * first. Returns a function that stops watching.
 */
export function stopWhenOrphaned(cleanup: () => void): () => void {
  return watchAncestors((pid) => {
    try { writeSync(2, `\nvitest: process ${pid}, which started this run, is gone; stopping the run and everything it started.\n`); } catch { /* no stderr left */ }
    for (const p of descendants(listProcesses(), process.pid)) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone already */ }
    try { cleanup(); } finally { process.exit(1); }
  });
}

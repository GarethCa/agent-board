import { spawn, type StdioOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SpawnDaemonOptions {
  /** The executable and arguments that run `agent-board daemon …`. */
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Where it runs: the caller's folder by default. */
  cwd?: string;
  /** Receives the daemon's stdout and stderr. */
  logPath: string;
}

/**
 * Starts the daemon detached, so it outlives the caller, logging to `logPath`. The returned promise settles when the
 * process exits: it resolves on exit 0 and rejects with the exit status and the end of this run's log otherwise, or
 * if the process could not be spawned. Pass it as `ensureDaemon`'s `start` so a daemon that dies at startup fails fast.
 */
export function spawnDetachedDaemon(options: SpawnDaemonOptions): Promise<void> {
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const logStart = fileSize(options.logPath);
  const log = openSync(options.logPath, 'a');
  const inheritable = inheritableDescriptors();
  // Only where there is something to cover: Windows has no /dev/null.
  const devNull = inheritable.length > 0 ? openSync('/dev/null', 'r') : undefined;
  try {
    const child = spawn(options.command, options.args, {
      detached: true,
      stdio: daemonStdio(log, inheritable, devNull ?? log),
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
    });
    child.unref();
    return new Promise((resolve, reject) => {
      child.once('error', (error) => reject(new Error(`could not run ${options.command}: ${error.message}`)));
      child.once('exit', (code, signal) => {
        if (code === 0) return resolve();
        const tail = logTail(options.logPath, logStart);
        reject(new Error(`daemon exited with ${signal ?? `code ${code}`}${tail ? `: ${tail}` : ''}`));
      });
    });
  } finally {
    closeSync(log);
    if (devNull !== undefined) closeSync(devNull);
  }
}

/**
 * The daemon's stdio: no stdin, `log` for stdout and stderr, and `devNull` over each of `inheritable`. The numbers
 * between are left alone: each /dev/null costs libuv a descriptor while it spawns, so covering every number up to a
 * high one could run out (EMFILE).
 *
 * Linux forks and execs, so the daemon would inherit every descriptor its caller left without close-on-exec, and hold
 * it for as long as it lives, long after the caller is gone. Electron leaves many: sockets, GPU cache files, and the
 * pipes of whatever launched the app, which then never sees the app's output end (Playwright's `app.close()` waits on
 * it forever). Pointing those descriptor numbers at /dev/null in the child closes the inherited ones. macOS spawns with
 * `POSIX_SPAWN_CLOEXEC_DEFAULT`, so nothing is inherited there and `inheritable` is empty.
 *
 * A descriptor Electron opens between `inheritableDescriptors()` and the spawn is still inherited. That window is
 * short, and such a descriptor is no worse than before.
 */
export function daemonStdio(log: number, inheritable: number[], devNull: number): StdioOptions {
  const covered = new Set(inheritable);
  const highest = Math.max(2, ...inheritable);
  return ['ignore', log, log, ...Array.from({ length: highest - 2 }, (_, i) => (covered.has(i + 3) ? devNull : 'ignore'))];
}

/** O_CLOEXEC in /proc's `flags`, which are octal. */
const O_CLOEXEC = 0o2000000;

/**
 * The descriptors past stdio this process has open without close-on-exec, from `/proc/self/fdinfo`. None where there's
 * no /proc to read (macOS, which needs none; see `daemonStdio`).
 */
export function inheritableDescriptors(fdinfo = '/proc/self/fdinfo'): number[] {
  let entries: string[];
  try {
    entries = readdirSync(fdinfo);
  } catch {
    return [];
  }
  return entries
    .map(Number)
    .filter((fd) => fd > 2)
    .filter((fd) => {
      try {
        const flags = /^flags:\s*([0-7]+)$/m.exec(readFileSync(`${fdinfo}/${fd}`, 'utf8'))?.[1];
        return flags !== undefined && (parseInt(flags, 8) & O_CLOEXEC) === 0;
      } catch {
        // Closed since it was listed.
        return false;
      }
    })
    .sort((a, b) => a - b);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The last few lines the log gained since `from`. */
function logTail(path: string, from: number): string {
  try {
    const lines = readFileSync(path).subarray(from).toString('utf8').trim().split('\n');
    return lines.slice(-5).join('\n');
  } catch {
    return '';
  }
}

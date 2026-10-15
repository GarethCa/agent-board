/**
 * The machine-wide lock on the Electron steps of a gate (e2e and visual): several workers gating at once pushed the load
 * average past 30 and starved the tests. One file holds the lock; the holder's PID and start time make a crashed or killed
 * holder recognisable as stale, and a waiter never waits for ever.
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Holder {
  pid: number;
  /** `ps`'s start time of the holder, so a recycled PID is not mistaken for it. */
  started: string;
  worktree: string;
  step: string;
  since: string;
}

export interface LockOptions {
  /** The lock file; default `AGENT_BOARD_E2E_LOCK` or `~/.cache/agent-board-gate/e2e.lock`. */
  file?: string;
  /** What this holder is running, shown to the others, e.g. `e2e`. */
  step: string;
  worktree: string;
  /** Give up after this long; default `AGENT_BOARD_E2E_LOCK_WAIT_MIN` minutes or 90. */
  maxWaitMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

export interface Lock {
  release(): void;
}

const DEFAULT_MAX_WAIT_MIN = 90;

function lockFile(): string {
  return process.env.AGENT_BOARD_E2E_LOCK ?? join(homedir(), '.cache', 'agent-board-gate', 'e2e.lock');
}

function maxWaitMs(): number {
  const minutes = Number(process.env.AGENT_BOARD_E2E_LOCK_WAIT_MIN ?? DEFAULT_MAX_WAIT_MIN);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`AGENT_BOARD_E2E_LOCK_WAIT_MIN is ${process.env.AGENT_BOARD_E2E_LOCK_WAIT_MIN}: give a number of minutes above 0`);
  }
  return minutes * 60_000;
}

/** The start time `ps` reports for `pid`, or undefined when there is no such process. */
export function processStart(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // `lstart` is local time: without a fixed zone and locale, contenders with another TZ would not recognise a live holder.
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

function readHolder(file: string): Holder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Holder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.started !== 'string') return undefined;
    return parsed as Holder;
  } catch {
    return undefined;
  }
}

/** A lock is stale when its holder is gone, or its PID now belongs to another process. An unreadable file is stale once a moment old. */
function isStale(file: string, holder: Holder | undefined): boolean {
  if (holder === undefined) {
    try {
      return Date.now() - statSync(file).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  return processStart(holder.pid) !== holder.started;
}

/** Tries to take the lock once. Returns undefined when someone else holds a live one (and which, via `holder`). */
function tryAcquire(file: string, mine: Holder): { acquired: true } | { acquired: false; holder?: Holder } {
  mkdirSync(dirname(file), { recursive: true });
  // The file is written whole to a private name and linked into place, so a reader never sees half a holder.
  const staging = `${file}.${mine.pid}.tmp`;
  writeFileSync(staging, JSON.stringify(mine));
  try {
    // `link` fails with EEXIST when the lock exists: an atomic create-if-absent.
    linkSync(staging, file);
    return { acquired: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    rmSync(staging, { force: true });
  }
  const holder = readHolder(file);
  // After a removal, try again at once; when another contender holds the reclaim guard, wait a poll like any other waiter.
  if (isStale(file, holder) && reclaim(file, holder)) return tryAcquire(file, mine);
  return { acquired: false, holder };
}

/** Removes a stale lock. Only one contender at a time does it (the guard), and it re-checks, so it never removes a lock a faster contender just took. */
function reclaim(file: string, seen: Holder | undefined): boolean {
  const guard = `${file}.reclaim`;
  try {
    mkdirSync(guard);
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10_000) rmSync(guard, { recursive: true, force: true });
    } catch {
      /* the guard went away: fine */
    }
    return false;
  }
  try {
    const now = readHolder(file);
    if (now?.pid !== seen?.pid || now?.started !== seen?.started || !isStale(file, now)) return false;
    rmSync(file, { force: true });
    return true;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

function describe(holder: Holder | undefined): string {
  if (holder === undefined) return 'another run';
  return `${holder.step} in ${holder.worktree} (pid ${holder.pid}, since ${holder.since})`;
}

/**
 * Waits for the lock, saying who holds it, and returns a handle. Released on `release()` and on the process ending,
 * including a signal; a kill -9 leaves a file the next contender finds stale. Throws after `maxWaitMs`.
 */
export async function acquireLock(options: LockOptions): Promise<Lock> {
  const file = options.file ?? lockFile();
  const log = options.log ?? ((message: string) => console.error(message));
  const limit = options.maxWaitMs ?? maxWaitMs();
  const pollMs = options.pollMs ?? 2_000;
  const started = processStart(process.pid);
  if (started === undefined) throw new Error('e2e lock: cannot read this process\'s start time from ps, so no lock can be recorded');
  const mine: Holder = {
    pid: process.pid,
    started,
    worktree: options.worktree,
    step: options.step,
    since: new Date().toISOString(),
  };
  const began = Date.now();
  let lastTold = '';
  let lastToldAt = 0;
  for (;;) {
    const result = tryAcquire(file, mine);
    if (result.acquired) break;
    const who = describe(result.holder);
    const waited = Date.now() - began;
    if (waited >= limit) {
      throw new Error(
        `e2e lock: gave up after ${Math.round(waited / 60_000)} min waiting for ${who}. If it is stuck, kill that process or delete ${file}; ` +
          `raise the limit with AGENT_BOARD_E2E_LOCK_WAIT_MIN.`,
      );
    }
    if (who !== lastTold || Date.now() - lastToldAt > 60_000) {
      log(`e2e lock: queued behind ${who}; waiting (at most ${Math.round(limit / 60_000)} min)`);
      lastTold = who;
      lastToldAt = Date.now();
    }
    await sleep(pollMs);
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    // Only our own lock: after a reclaim by someone who judged us dead, the file is theirs.
    const current = readHolder(file);
    if (current?.pid === mine.pid && current.started === mine.started) rmSync(file, { force: true });
  };
  process.on('exit', release);
  return { release };
}

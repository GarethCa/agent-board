import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isProcessAlive } from './pid.ts';

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number | undefined;

  constructor(pid: number | undefined) {
    super(`an agent-board daemon${pid === undefined ? '' : ` (pid ${pid})`} already owns this data dir`);
    this.pid = pid;
  }
}

/** A lock younger than this whose socket does not answer yet belongs to a daemon that is still starting. */
const STARTUP_GRACE_MS = 10_000;

/**
 * Takes the data dir's daemon lock: a file holding the owner's pid. Returns the release function.
 *
 * - The lock is published with `link`, which fails if the file exists, so it never exists without a pid in it.
 * - A lock is stale when its pid is gone, or when the pid is alive (possibly reused by an unrelated process) but the
 *   socket has not answered for longer than a daemon takes to start. An unreadable lock is stale once that old.
 * - A stale lock is taken over by renaming it aside, which only one contender can do; the contender then checks it
 *   moved the lock it judged stale and not a fresh one, and puts a fresh one back.
 */
export async function acquireDaemonLock(lockPath: string, socketPath: string): Promise<() => void> {
  const unique = `${process.pid}-${randomBytes(4).toString('hex')}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (publish(lockPath, `${lockPath}.new-${unique}`)) {
      return () => {
        if (readLockPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
      };
    }
    const pid = readLockPid(lockPath);
    const age = lockAgeMs(lockPath);
    if (age === Infinity) continue; // released between our attempt and the read
    const young = age < STARTUP_GRACE_MS;
    if (pid === undefined ? young : isProcessAlive(pid) && (young || (await socketAnswers(socketPath)))) {
      throw new DaemonAlreadyRunningError(pid);
    }
    const aside = `${lockPath}.stale-${unique}`;
    try {
      renameSync(lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // another contender moved it first
      throw error;
    }
    if (readLockPid(aside) !== pid) {
      // We moved a lock someone published after our check. Restore it unless a newer one has appeared since.
      try {
        linkSync(aside, lockPath);
      } catch {
        // a newer lock is in place; it wins
      }
    }
    rmSync(aside, { force: true });
  }
  throw new DaemonAlreadyRunningError(readLockPid(lockPath));
}

/** Writes our pid to a temp file and links it into place. False if a lock already exists. */
function publish(lockPath: string, tempPath: string): boolean {
  writeFileSync(tempPath, String(process.pid), { mode: 0o600 });
  try {
    linkSync(tempPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/** The pid in a daemon lock file, or undefined if it is missing or unreadable. */
export function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return Infinity;
  }
}

function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

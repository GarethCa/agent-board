import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DaemonPaths {
  dataDir: string;
  /** The SQLite database (ADR-0005). */
  database: string;
  /**
   * Where clients connect: `daemon.sock` in the data dir, or a named pipe on Windows. Unix socket paths are capped
   * (104 bytes on macOS, 108 on Linux), so a long data dir gets a short socket path under the temp dir instead.
   */
  socket: string;
  /** Holds the running daemon's pid, so only one daemon owns a data dir. */
  lock: string;
  /** The detached daemon's stdout and stderr. */
  log: string;
}

/** Longest socket path used as is; leaves headroom under macOS's 104-byte cap. */
export const MAX_SOCKET_PATH_BYTES = 100;

export function daemonPaths(dataDir: string): DaemonPaths {
  const id = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  return {
    dataDir,
    database: join(dataDir, 'agent-board.db'),
    socket: socketPath(dataDir, id),
    lock: join(dataDir, 'daemon.lock'),
    log: join(dataDir, 'daemon.log'),
  };
}

/**
 * The app's own data dir, as Electron names it (`app.getPath('userData')` for the app called `agent-board`), so a CLI
 * run outside the app finds the daemon the app starts.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'agent-board');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'agent-board');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'agent-board');
}

function socketPath(dataDir: string, id: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\agent-board-${id}`;
  const inDataDir = join(dataDir, 'daemon.sock');
  if (Buffer.byteLength(inDataDir) <= MAX_SOCKET_PATH_BYTES) return inDataDir;
  const short = join(tmpdir(), `agent-board-${id}`, 'daemon.sock');
  if (Buffer.byteLength(short) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`no socket path short enough for data dir ${dataDir}; set TMPDIR to a shorter directory`);
  }
  return short;
}

/**
 * Creates the data dir, ours alone: `mkdirSync`'s mode applies only to a folder it makes, so one that already exists
 * (made by hand, or by an older build) is set to 0700 too. A folder this user can't change the mode of (one another
 * user owns, or a filesystem with no modes) is logged and left: the socket in it is 0600 regardless.
 */
export function prepareDataDir(paths: DaemonPaths, log: (message: string) => void): void {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    chmodSync(paths.dataDir, 0o700);
  } catch (error) {
    log(`could not make the data dir ${paths.dataDir} private (0700): ${(error as Error).message}`);
  }
}

/**
 * Listens on the socket, replacing a stale socket file (safe: the caller holds the data dir's lock). The socket is
 * 0600 from the moment it is at `socketPath`: it is bound in a fresh 0700 folder beside it, made 0600 there and then
 * renamed into place, so no one else can connect in between and nothing process-wide (such as the umask) changes. The
 * folder's name is short enough that the bound path is no longer than `socketPath`, which already fits the limit.
 */
export async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  if (process.platform === 'win32') return listen(server, socketPath);
  const privateDir = mkdtempSync(join(dirname(socketPath), '.s'));
  const bound = join(privateDir, 's');
  try {
    await listen(server, bound);
    chmodSync(bound, 0o600);
    renameSync(bound, socketPath);
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Creates the directory the socket lives in. When that is the shared temp dir fallback, it must be ours alone: a
 * 0700 directory owned by this user, not a symlink, so nobody else can plant or read the socket.
 */
export function prepareSocketDir(paths: DaemonPaths): void {
  if (process.platform === 'win32') return;
  const dir = dirname(paths.socket);
  if (dir === paths.dataDir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`refusing socket dir ${dir}: it must be a 0700 directory owned by this user`);
  }
}

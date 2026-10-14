import { setTimeout as sleep } from 'node:timers/promises';
import { connectDaemon, DaemonRpcError, type DaemonClient } from './client.ts';
import { readLockPid } from './lock.ts';
import { daemonPaths } from './paths.ts';
import { isProcessAlive } from './pid.ts';
import { RPC_ERROR } from './protocol.ts';

export type StopDaemonResult =
  | { status: 'not-running' }
  | { status: 'stopped'; pid: number }
  /** Sessions are live and `force` was not set: the daemon was left running. */
  | { status: 'sessions-live'; liveSessions: number };

export interface StopDaemonOptions {
  /** Stop even while sessions are live, ending them. */
  force?: boolean;
  /** How long to wait for the daemon to let go of the data dir. */
  timeoutMs?: number;
}

/**
 * Stops the daemon that owns `dataDir`, if one answers, and resolves once it has released the data dir's lock (so a
 * new daemon can start there) or died. Without `force` it leaves a daemon with live sessions running.
 */
export async function stopDaemon(dataDir: string, options: StopDaemonOptions = {}): Promise<StopDaemonResult> {
  const paths = daemonPaths(dataDir);
  let client: DaemonClient;
  try {
    client = await connectDaemon(paths.socket);
  } catch {
    return { status: 'not-running' };
  }
  let pid: number;
  try {
    const health = await client.call('daemon.health');
    pid = health.pid;
    const { stopped, liveSessions } = await askToStop(client, pid, health.liveSessions, options.force === true);
    if (!stopped) return { status: 'sessions-live', liveSessions };
  } finally {
    client.close();
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  // A daemon that died mid-shutdown leaves its lock; the next daemon treats a dead pid's lock as stale.
  while (readLockPid(paths.lock) === pid && isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`the agent-board daemon (pid ${pid}) did not stop`);
    await sleep(25);
  }
  return { status: 'stopped', pid };
}

/** `daemon.stop`, or SIGTERM for a daemon from before that method existed. */
async function askToStop(
  client: DaemonClient,
  pid: number,
  liveSessions: number,
  force: boolean,
): Promise<{ stopped: boolean; liveSessions: number }> {
  try {
    return await client.call('daemon.stop', { force });
  } catch (error) {
    if (!(error instanceof DaemonRpcError && error.code === RPC_ERROR.methodNotFound)) throw error;
  }
  if (liveSessions > 0 && !force) return { stopped: false, liveSessions };
  if (isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
  return { stopped: true, liveSessions };
}

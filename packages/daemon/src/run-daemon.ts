import { logLine } from './log-line.ts';
import type { Daemon, DaemonOptions } from './daemon.ts';
import { describeBuild } from './protocol.ts';

/**
 * Runs a daemon in this process until it exits (idle, stopped or signalled), as `agent-board daemon` does. `started`
 * runs once it is up. Resolves to the exit code: 0 when the daemon went idle or was signalled, or when another daemon
 * already owns the data dir (a launcher that lost a start race is not an error); 1 when it could not start. Its agents'
 * hooks run this process's own `agent-board` unless `options` names another forwarder.
 */
export async function runDaemon(options: DaemonOptions, started?: (daemon: Daemon) => Promise<void>): Promise<number> {
  // Loaded only to run the daemon: the board commands start often, and need none of it.
  const { startDaemon } = await import('./daemon.ts');
  const { DaemonAlreadyRunningError } = await import('./lock.ts');
  const { cliBanner } = await import('./cli-banner.ts');
  let daemon;
  try {
    daemon = await startDaemon({ hookForwarder: { command: process.execPath, args: process.argv.slice(1, 2) }, ...options });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      console.log(logLine(`${error.message}; leaving it running`));
      return 0;
    }
    console.error(logLine(`could not start: ${(error as Error).message}`));
    return 1;
  }
  console.log(cliBanner({ version: describeBuild(options.build ?? null), ...daemon.startedWith }));
  const stop = () => void daemon.stop();
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, stop);
  try {
    await started?.(daemon);
  } catch (error) {
    console.error(logLine((error as Error).message));
  }
  await daemon.closed;
  for (const signal of signals) process.off(signal, stop);
  return 0;
}

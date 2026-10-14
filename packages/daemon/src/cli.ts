import { parseArgs } from 'node:util';
import { cliBanner } from './cli-banner.ts';
import { startDaemon } from './daemon.ts';
import { runHookCommand } from './hook-forwarder.ts';
import { DaemonAlreadyRunningError } from './lock.ts';
import { describeBuild, runningSessions, type BuildInfo } from './protocol.ts';
import { stopDaemon } from './stop.ts';

export const USAGE = [
  'usage: agent-board daemon --data-dir <dir> [--idle-timeout-ms <ms>] [--permission-hold-ms <ms>]',
  '       agent-board stop --data-dir <dir> [--force]',
  '       agent-board hook codex',
  '       agent-board hook external claude|codex',
].join('\n');

/**
 * `agent-board stop`'s exit code when it left the daemon running because sessions are live.
 */
export const EXIT_SESSIONS_LIVE = 3;

export interface AgentBoardCliOptions {
  /** The build this executable is, which a daemon it starts reports. */
  build?: BuildInfo;
}

/**
 * The `agent-board` command line: `daemon`; `stop`, which stops the daemon on a data dir; and `hook`, the forwarder
 * Codex's hooks and the external hooks run (see `hook-forwarder.ts`). Resolves to the exit code: 0 when the daemon went idle or was
 * signalled, or when another daemon already owns the data dir (a launcher that lost a start race is not an error);
 * 0 when `stop` stopped the daemon or none was running, `EXIT_SESSIONS_LIVE` when it refused to end live sessions;
 * 1 when the daemon could not start or stop; 2 on bad arguments.
 */
export async function runAgentBoardCli(argv: string[], options: AgentBoardCliOptions = {}): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'hook' && args.length === 1 && args[0] === 'codex') return runHookCommand(args);
  if (command === 'hook' && args.length === 2 && args[0] === 'external' && (args[1] === 'claude' || args[1] === 'codex')) {
    return runHookCommand(args);
  }
  if (command === 'stop') return runStopCommand(args);
  if (command !== 'daemon') {
    console.error(USAGE);
    return 2;
  }
  let values: { 'data-dir'?: string; 'idle-timeout-ms'?: string; 'permission-hold-ms'?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string' },
        'idle-timeout-ms': { type: 'string' },
        'permission-hold-ms': { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const dataDir = values['data-dir'];
  const milliseconds = (value: string | undefined) => (value === undefined ? undefined : Number(value));
  const idleTimeoutMs = milliseconds(values['idle-timeout-ms']);
  const permissionHoldMs = milliseconds(values['permission-hold-ms']);
  const valid = (ms: number | undefined) => ms === undefined || ms >= 0;
  if (dataDir === undefined || !valid(idleTimeoutMs) || !valid(permissionHoldMs)) {
    console.error(USAGE);
    return 2;
  }

  let daemon;
  try {
    daemon = await startDaemon({
      dataDir,
      build: options.build,
      idleTimeoutMs,
      permissionHoldMs,
      hookForwarder: { command: process.execPath, args: process.argv.slice(1, 2) },
    });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      console.log(`[agent-board daemon] ${error.message}; leaving it running`);
      return 0;
    }
    console.error(`[agent-board daemon] could not start: ${(error as Error).message}`);
    return 1;
  }
  console.log(cliBanner({ version: describeBuild(options.build ?? null), ...daemon.startedWith }));
  const stop = () => void daemon.stop();
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, stop);
  await daemon.closed;
  for (const signal of signals) process.off(signal, stop);
  return 0;
}

async function runStopCommand(args: string[]): Promise<number> {
  let values: { 'data-dir'?: string; force?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { 'data-dir': { type: 'string' }, force: { type: 'boolean' } },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const dataDir = values['data-dir'];
  if (dataDir === undefined) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await stopDaemon(dataDir, { force: values.force });
    if (result.status === 'sessions-live') {
      // The hint is a line of its own, so a caller can show the first line before asking its own question.
      console.error(
        `The daemon has ${runningSessions(result.liveSessions)}, which stopping it would end.\n` +
          'Re-run with --force to stop it anyway.',
      );
      return EXIT_SESSIONS_LIVE;
    }
    console.log(result.status === 'stopped' ? `stopped the daemon (pid ${result.pid})` : 'no daemon is running');
    return 0;
  } catch (error) {
    console.error(`could not stop the daemon: ${(error as Error).message}`);
    return 1;
  }
}

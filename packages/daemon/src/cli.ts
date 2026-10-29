import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { BOARD_COMMANDS, runBoardCommand } from './board-cli.ts';
import { daemonLaunchEnv, runsUnderDaemon } from './daemon-launch.ts';
import { runHookCommand } from './hook-forwarder.ts';
import { daemonPaths } from './paths.ts';
import { describeBuild, runningSessions, type BuildInfo } from './protocol.ts';
import { restartDaemon, type RestartDaemonResult } from './restart.ts';
import { spawnDetachedDaemon } from './spawn.ts';
import { stopDaemon } from './stop.ts';

/** The app's own commands; `agent-board --help` documents the rest, the board's. */
export const USAGE = [
  'usage: agent-board daemon --data-dir <dir> [--idle-timeout-ms <ms>] [--permission-hold-ms <ms>]',
  '       agent-board stop --data-dir <dir> [--force]',
  '       agent-board restart-daemon --data-dir <dir>',
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
  /** How `restart-daemon` starts this build's daemon on a data dir: detached, as this executable, by default. */
  startDaemon?: (dataDir: string) => void | Promise<void>;
}

/**
 * The `agent-board` command line: the board's commands for agents and people (`board-cli.ts`, ADR-0010); `daemon`;
 * `stop`, which stops the daemon on a data dir; `restart-daemon`, which restarts it as this build and resumes its
 * sessions; and `hook`, the forwarder Codex's hooks and the external hooks run (see `hook-forwarder.ts`). Resolves to
 * the exit code: 0 when the daemon went idle or was signalled, or when another daemon already owns the data dir (a
 * launcher that lost a start race is not an error); 0 when `stop` stopped the daemon or none was running,
 * `EXIT_SESSIONS_LIVE` when it refused to end live sessions; 0 when `restart-daemon` restarted the daemon (whether or
 * not every session resumed) or none was running; 1 when the daemon could not start, stop or restart; 2 on bad
 * arguments.
 */
export async function runAgentBoardCli(argv: string[], options: AgentBoardCliOptions = {}): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === '--help' || command === '-h') return runBoardCommand('help', []);
  if (BOARD_COMMANDS.has(command)) return runBoardCommand(command, args);
  if (command === 'hook' && args.length === 1 && args[0] === 'codex') return runHookCommand(args);
  if (command === 'hook' && args.length === 2 && args[0] === 'external' && (args[1] === 'claude' || args[1] === 'codex')) {
    return runHookCommand(args);
  }
  if (command === 'stop') return runStopCommand(args);
  if (command === 'restart-daemon') return runRestartCommand(args, options.startDaemon ?? startDetachedDaemon, options.build);
  if (command === 'hook') {
    console.error(USAGE);
    return 2;
  }
  if (command !== 'daemon') {
    console.error(`agent-board: no command ${command}. \`agent-board --help\` lists them.`);
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

  // Loaded only to run the daemon: the board commands start often, and need none of it.
  const { startDaemon } = await import('./daemon.ts');
  const { DaemonAlreadyRunningError } = await import('./lock.ts');
  const { cliBanner } = await import('./cli-banner.ts');
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

async function runRestartCommand(args: string[], start: (dataDir: string) => void | Promise<void>, build: BuildInfo | undefined): Promise<number> {
  let values: { 'data-dir'?: string };
  try {
    ({ values } = parseArgs({ args, options: { 'data-dir': { type: 'string' } }, strict: true }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const dataDir = values['data-dir'];
  if (dataDir === undefined) {
    console.error(USAGE);
    return 2;
  }
  const inside = runsUnderDaemon(dataDir);
  if (inside !== false) {
    console.error(inside === true ? RESTART_FROM_INSIDE : RESTART_UNSURE);
    return 1;
  }
  let result: RestartDaemonResult;
  try {
    result = await restartDaemon(dataDir, { start: () => start(dataDir), build });
  } catch (error) {
    console.error(`could not restart the daemon: ${(error as Error).message}. Open agent-board: it offers to restart the daemon, or to resume what was stopped.`);
    return 1;
  }
  if (result.status === 'not-running') {
    console.log('no daemon is running, so there was nothing to restart: the app starts one when it opens');
    return 0;
  }
  console.log(restartSummary(result));
  // The daemon did restart: what didn't resume waits on the board, stopped by restart, with its own Resume.
  for (const { name, message } of result.notResumed) console.error(`could not resume ${name}: ${message}. Resume it from its tile.`);
  return 0;
}

/**
 * Why `restart-daemon` won't run inside a session of the daemon it restarts: stopping that daemon ends the session, and
 * this command with it, before the new daemon starts or anything is resumed.
 */
export const RESTART_FROM_INSIDE =
  'this runs inside a board session (a shell or an agent) of the daemon it would restart, and stopping that daemon ' +
  'would end it before the new one started. Run it from a terminal outside agent-board, or press Restart daemon in the app.';

/** Why `restart-daemon` won't run when it can't tell whether it is in such a session: guessing wrong would end it. */
const RESTART_UNSURE =
  "could not tell whether this runs inside a board session of the daemon it would restart (its process ancestry couldn't " +
  'be read), and stopping that daemon would end it. Run it from a terminal outside agent-board, or press Restart daemon in the app.';

/** What `restart-daemon` did, in words: the builds, then what it resumed, and the turns it cut short. */
function restartSummary(result: Extract<RestartDaemonResult, { status: 'restarted' }>): string {
  const { from, to, agents, panes, midTurn } = result;
  const lines = [`restarted the daemon: ${describeBuild(from.build)} (pid ${from.pid}) → ${describeBuild(to.build)} (pid ${to.pid})`];
  const resumed = [
    ...(agents.length > 0 ? [`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} (${agents.join(', ')})`] : []),
    ...(panes > 0 ? [`${panes} shell ${panes === 1 ? 'pane' : 'panes'}`] : []),
  ];
  lines.push(resumed.length > 0 ? `resumed ${resumed.join(' and ')}` : 'no sessions were running, so none were resumed');
  if (midTurn.length > 0) {
    lines.push(
      `${midTurn.length === 1 ? 'this agent was' : 'these agents were'} mid-turn and lost that turn: ${midTurn.join(', ')}. ` +
        'Send each a message to carry on.',
    );
  }
  return lines.join('\n');
}

/** Starts this build's daemon on `dataDir` as the app does: detached, this executable running `daemon`, logging to the data dir. */
function startDetachedDaemon(dataDir: string): Promise<void> {
  // From the home folder, as the app's daemon runs: not a checkout or worktree that may later be removed.
  return spawnDetachedDaemon({
    ...detachedDaemonLaunch(dataDir, process.execPath, process.argv, process.env),
    cwd: homedir(),
    logPath: daemonPaths(dataDir).log,
  });
}

/** How `restart-daemon` runs this build's daemon: the executable and script it runs as (`argv[1]`), with the caller's env cleaned. */
export function detachedDaemonLaunch(dataDir: string, execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) {
  return { command: execPath, args: [...argv.slice(1, 2), 'daemon', '--data-dir', dataDir], env: daemonLaunchEnv(env) };
}

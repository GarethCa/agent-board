import { connectDaemon, ensureDaemon, type DaemonClient } from './client.ts';
import { daemonPaths } from './paths.ts';
import { describeBuild, sameBuild, type BuildInfo } from './protocol.ts';
import { stopDaemon } from './stop.ts';

/** The daemon a restart found, or the one it started. */
interface DaemonRun {
  pid: number;
  build: BuildInfo | null;
}

/** A session the restart stopped and could not start again, and why. */
interface NotResumed {
  name: string;
  message: string;
}

export type RestartDaemonResult =
  | { status: 'not-running' }
  | {
      status: 'restarted';
      from: DaemonRun;
      to: DaemonRun;
      /** The names of the agents it stopped and resumed. */
      agents: string[];
      /** How many shell panes it stopped and resumed. */
      panes: number;
      /** The names of the agents it resumed that were cut off mid-turn: each waits at its prompt for the user's Carry on. */
      midTurn: string[];
      notResumed: NotResumed[];
    };

interface RestartDaemonOptions {
  /** Starts this build's daemon on the data dir, as `ensureDaemon`'s `start`. */
  start: () => void | Promise<void>;
  /** This build, which the daemon answering after the restart must be before anything is resumed on it. */
  build?: BuildInfo;
}

/**
 * Restarts the daemon on `dataDir` as this build, keeping the board as it was: stops it even with sessions live (they
 * are stopped by restart, ADR-0002), starts this build's daemon with `start`, and waits while that daemon's start
 * brings back each agent and shell pane the stop ended (`daemon.afterRestart`), typing nothing to any. An agent it cut
 * off mid-turn is named for it. Starts nothing when no daemon is running. Throws when this build's daemon doesn't start
 * or another build's answers first, whose start may not bring anything back.
 */
export async function restartDaemon(dataDir: string, options: RestartDaemonOptions): Promise<RestartDaemonResult> {
  const { socket } = daemonPaths(dataDir);
  let old: DaemonClient;
  try {
    old = await connectDaemon(socket);
  } catch {
    return { status: 'not-running' };
  }
  let from: DaemonRun;
  try {
    from = run(await old.call('daemon.health'));
  } finally {
    old.close();
  }
  await stopDaemon(dataDir, { force: true });

  let client: DaemonClient;
  try {
    client = await ensureDaemon({ socketPath: socket, start: options.start });
  } catch (error) {
    throw new Error(`stopped the old daemon, but this build's did not start: ${(error as Error).message}`, { cause: error });
  }
  try {
    const to = run(await client.call('daemon.health'));
    // An app still open on another build may start its own daemon first: resumed there, sessions would run on it.
    if (options.build !== undefined && !sameBuild(options.build, to.build)) {
      throw new Error(`stopped the old daemon, but one from build ${describeBuild(to.build)} started in its place, not this build's ${describeBuild(options.build)}, which may bring back nothing`);
    }
    // The daemon's start brings back what the stop ended, and says what it did once it has.
    const { agents, cutOff: midTurn, panes, notResumed } = await client.call('daemon.afterRestart');
    return { status: 'restarted', from, to, agents, panes, midTurn, notResumed };
  } finally {
    client.close();
  }
}

function run(health: { pid: number; build?: BuildInfo | null }): DaemonRun {
  return { pid: health.pid, build: health.build ?? null };
}

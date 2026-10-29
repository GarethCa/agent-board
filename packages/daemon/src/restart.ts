import { connectDaemon, ensureDaemon, type DaemonClient } from './client.ts';
import { daemonPaths } from './paths.ts';
import { describeBuild, isMidTurn, sameBuild, type Agent, type BuildInfo, type Shell } from './protocol.ts';
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
      /** The names of the agents that were mid-turn, or still starting, when it stopped them: that turn is lost. */
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
 * are stopped by restart, ADR-0002), starts this build's daemon with `start`, and resumes each agent and shell pane the
 * stop ended, as Resume all would. Nothing is typed at a resumed agent. An agent mid-turn loses that turn, and is named
 * for it. Starts nothing when no daemon is running. Throws, resuming nothing, when this build's daemon doesn't start
 * or another build's answers first: what the stop ended waits on the board, stopped by restart.
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
  let before: { agents: Agent[]; shells: Shell[] };
  try {
    from = run(await old.call('daemon.health'));
    // Only the fields every daemon has sent are read: the old daemon may be from any earlier build.
    before = { agents: await old.call('agent.list'), shells: await old.call('shell.list') };
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
      throw new Error(`stopped the old daemon, but one from build ${describeBuild(to.build)} started in its place, not this build's ${describeBuild(options.build)}, so nothing was resumed`);
    }
    const wasStopped = new Set(before.agents.filter((agent) => agent.state === 'stopped-by-restart').map((agent) => agent.sessionId));
    const wasLive = new Map(before.agents.filter((agent) => agent.endedAt === null).map((agent) => [agent.sessionId, agent]));
    const agents: string[] = [];
    const notResumed: NotResumed[] = [];
    for (const agent of await client.call('agent.list')) {
      if (agent.state !== 'stopped-by-restart' || wasStopped.has(agent.sessionId)) continue;
      try {
        await client.call('agent.resume', { sessionId: agent.sessionId });
        agents.push(agent.name);
      } catch (error) {
        notResumed.push({ name: agent.name, message: (error as Error).message });
      }
    }
    const stoppedBefore = new Set(before.shells.flatMap((shell) => shell.stoppedPanes));
    let panes = 0;
    for (const shell of await client.call('shell.list')) {
      for (const sessionId of shell.stoppedPanes.filter((pane) => !stoppedBefore.has(pane))) {
        try {
          await client.call('shell.resumePane', { shellId: shell.id, sessionId });
          panes += 1;
        } catch (error) {
          notResumed.push({ name: `a pane of ${shell.name}`, message: (error as Error).message });
        }
      }
    }
    const midTurn = [...wasLive.values()].filter(busy).map((agent) => agent.name);
    return { status: 'restarted', from, to, agents, panes, midTurn, notResumed };
  } finally {
    client.close();
  }
}

/** Mid-turn or still starting; an older daemon's agent may lack `ask` and `plan`, read as none. */
function busy(agent: Agent): boolean {
  return agent.state === 'starting' || isMidTurn({ state: agent.state, ask: agent.ask ?? null, plan: agent.plan ?? null });
}

function run(health: { pid: number; build?: BuildInfo | null }): DaemonRun {
  return { pid: health.pid, build: health.build ?? null };
}

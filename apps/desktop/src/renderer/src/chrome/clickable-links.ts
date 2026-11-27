import type { Agent, DaemonSettings } from '@agent-board/daemon/protocol';
import type { AgentBoardApi } from '../../../preload/api';

/** What the clickable links switch shows, from the daemon's settings as far as they are read. */
export interface ClickableLinksView {
  /** Whether the switch is drawn on. */
  checked: boolean;
  /** Whether a `FORCE_HYPERLINK` the user set in their environment decides it, so the switch can't change anything. */
  locked: boolean;
}

type LinkSettings = Pick<DaemonSettings, 'clickableLinks' | 'clickableLinksFromEnvironment'>;

/** The switch for `settings`, undefined until they are read: on by default, and the user's own variable wins. */
export function clickableLinksView(settings: LinkSettings | undefined): ClickableLinksView {
  const own = settings?.clickableLinksFromEnvironment ?? null;
  if (own !== null) return { checked: own, locked: true };
  return { checked: settings?.clickableLinks ?? true, locked: false };
}

/**
 * The live Claude agents this daemon started the other way from the switch, which a restart would change. None while the
 * user's own variable decides it: a restart would start them just as they are. Worked out afresh from the agents each
 * time, so the offer is there again whenever Settings opens.
 */
export function startedOtherwise(agents: Iterable<Agent>, settings: LinkSettings | undefined): Agent[] {
  if (settings === undefined || settings.clickableLinksFromEnvironment !== null) return [];
  return [...agents].filter(
    (agent) => agent.harness === 'claude' && agent.endedAt === null && agent.clickableLinks !== null && agent.clickableLinks !== settings.clickableLinks,
  );
}

type Agents = Pick<AgentBoardApi['agents'], 'stop' | 'restart'>;

/** An agent stopped for its restart whose shell runs something (`message`, the daemon's words): it asks before ending that. */
export interface BusyShell {
  sessionId: string;
  name: string;
  message: string;
}

/**
 * Stops and restarts each agent, one at a time, so one agent's trouble never leaves the rest unrestarted: `failed` says
 * why one did not, in a line each (`describe` words its error), and `asking` lists those whose shell is busy.
 */
export async function restartForLinks(agents: Agent[], api: Agents, describe: (error: unknown) => string): Promise<{ failed: string[]; asking: BusyShell[] }> {
  const failed: string[] = [];
  const asking: BusyShell[] = [];
  for (const agent of agents) {
    try {
      await api.stop(agent.sessionId);
      const result = await api.restart(agent.sessionId);
      if (result.status === 'busy') asking.push({ sessionId: agent.sessionId, name: agent.name, message: result.message });
    } catch (error) {
      failed.push(`${agent.name} could not be restarted: ${describe(error)}`);
    }
  }
  return { failed, asking };
}

/**
 * Wake anyway, for a busy shell: restarts it with `force`. `asking` while its shell is still to be asked about (a wake
 * already going for it found it busy), else not, with the line to show (`problem`) when it failed.
 */
export async function wakeAnyway(shell: BusyShell, api: Agents, describe: (error: unknown) => string): Promise<{ asking: true } | { asking: false; problem?: string }> {
  try {
    return (await api.restart(shell.sessionId, true)).status === 'busy' ? { asking: true } : { asking: false };
  } catch (error) {
    return { asking: false, problem: `${shell.name} could not be restarted: ${describe(error)}` };
  }
}

/** What stays said of a busy shell's agent once its wake is cancelled: Settings stopped it, and it stays stopped. */
export const cancelledLine = (shell: Pick<BusyShell, 'name'>): string => `${shell.name} is stopped: wake it from its tile.`;

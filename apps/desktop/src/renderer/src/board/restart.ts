// The sessions a restart stopped (the daemon or the machine went away under them), which the board offers to wake.
import type { Agent, Shell } from '@agent-board/daemon/protocol';

/** The agents and the shell tiles with panes a restart stopped, and all their session IDs. */
export function stoppedByRestart(
  agents: readonly Agent[],
  shells: readonly Shell[] | undefined,
): { agents: Agent[]; shells: Shell[]; ids: string[] } {
  const stoppedAgents = agents.filter((agent) => agent.state === 'stopped-by-restart');
  const stoppedShells = (shells ?? []).filter((shell) => shell.stoppedPanes.length > 0);
  return {
    agents: stoppedAgents,
    shells: stoppedShells,
    ids: [...stoppedAgents.map((agent) => agent.sessionId), ...stoppedShells.flatMap((shell) => shell.stoppedPanes)],
  };
}

type Stopped = ReturnType<typeof stoppedByRestart>;

/**
 * The agents a restart stopped that were working: cut off mid-turn, and not on a permission prompt. One idle at its
 * prompt, waiting on or asking the user, stays asleep until its own Wake; so does one from an older daemon, which
 * doesn't say.
 */
function working(stopped: Stopped): Agent[] {
  return stopped.agents.filter((agent) => agent.state === 'stopped-by-restart' && agent.cutOffMidTurn === true && agent.cutOffAsking !== true);
}

/**
 * What Wake all wakes: the agents that were working, and the stopped shells' panes, which spend nothing. Null when there
 * is neither, and the banner has no Wake all.
 */
export function wakeAll(stopped: Stopped): { agents: Agent[]; shells: Shell[] } | null {
  const agents = working(stopped);
  return agents.length === 0 && stopped.shells.length === 0 ? null : { agents, shells: stopped.shells };
}

/**
 * The banner's words, naming all Wake all wakes: "8 sessions stopped when your Mac restarted · 3 were working", and
 * ", 1 shell" when a shell's panes stopped too.
 */
export function restartMessage(stopped: Stopped, mac: boolean): string {
  const count = stopped.ids.length;
  const busy = working(stopped).length;
  const shells = stopped.shells.length;
  const head = `${count} ${count === 1 ? 'session' : 'sessions'} stopped when your ${mac ? 'Mac' : 'computer'} restarted`;
  const were = `${busy === 0 ? 'none was' : busy === 1 ? '1 was' : `${busy} were`} working`;
  return `${head} · ${were}${shells === 0 ? '' : `, ${shells} ${shells === 1 ? 'shell' : 'shells'}`}`;
}

/** Whether the banner shows: some stopped session is not one the user dismissed it for. */
export function restartBannerShown(stopped: readonly string[], dismissed: readonly string[]): boolean {
  return stopped.some((id) => !dismissed.includes(id));
}

/**
 * The dismissals still standing: those of sessions still stopped. One resumed since is forgotten, so a later restart
 * that stops it again shows the banner.
 */
export function dismissedStill(dismissed: readonly string[], stopped: readonly string[]): string[] {
  return dismissed.filter((id) => stopped.includes(id));
}

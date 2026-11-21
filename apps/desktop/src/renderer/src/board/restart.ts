// The sessions a restart stopped (the daemon or the machine went away under them): those the daemon's start brought
// back, of which the board offers to tell the ones cut off mid-turn to carry on, and those still stopped, which it
// offers to wake.
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
 * The agents the daemon's start brought back that a restart had cut off mid-turn, not on a permission prompt: each
 * waits at its prompt, told nothing, for the user's Carry on.
 */
export function cutOffBack(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.backAfterRestart === true && agent.endedAt === null && agent.cutOffMidTurn === true && agent.cutOffAsking !== true);
}

/**
 * Of what a restart stopped, what the user hasn't dismissed the banner for: what it counts, and what Wake all wakes. One
 * an earlier restart stopped, put away then, is left to its own Wake.
 */
export function undismissed(stopped: Stopped, dismissed: readonly string[]): Stopped {
  const shown = (id: string) => !dismissed.includes(id);
  return {
    agents: stopped.agents.filter((agent) => shown(agent.sessionId)),
    shells: stopped.shells.filter((shell) => shell.stoppedPanes.some(shown)),
    ids: stopped.ids.filter(shown),
  };
}

/**
 * Carry on: tells each of `cutOff` to carry on, and nothing else. No agent still stopped is woken: that is Wake all's,
 * which the banner offers once Carry on is done. Settles with the ones told, which the banner puts away; one that
 * couldn't be told (busy, or the user typing at it) keeps its Carry on.
 */
export async function carryOn(cutOff: readonly Agent[], tell: (sessionId: string) => Promise<boolean>): Promise<string[]> {
  const told = await Promise.all(cutOff.map(async (agent) => ((await tell(agent.sessionId)) ? agent.sessionId : undefined)));
  return told.filter((id) => id !== undefined);
}

/** What the banner is about: the sessions still stopped, and the agents brought back that wait for Carry on. */
export function restartIds(stopped: Stopped, cutOff: readonly Agent[]): string[] {
  return [...stopped.ids, ...cutOff.map((agent) => agent.sessionId)];
}

/**
 * Whether the daemon's start is still bringing back what the restart stopped: the banner waits until it has, then
 * says what came back, so its Wake all never races the start's own resume.
 */
export function restartPassRunning(agents: readonly Agent[]): boolean {
  return agents.some((agent) => agent.comingBackAfterRestart === true);
}

/**
 * The banner's words. With nothing brought back, naming all Wake all wakes: "8 sessions stopped when your Mac
 * restarted · 3 were working", and ", 1 shell" when a shell's panes stopped too. With agents brought back: "5 came
 * back after the restart · 2 were cut off mid-turn", and " · 1 stayed stopped" for the sessions still stopped.
 */
export function restartMessage(stopped: Stopped, mac: boolean, agents: readonly Agent[] = []): string {
  const back = agents.filter((agent) => agent.backAfterRestart === true && agent.endedAt === null).length;
  const count = stopped.ids.length;
  if (back > 0) {
    const cutOff = cutOffBack(agents).length;
    const were = cutOff === 0 ? '' : ` · ${cutOff} ${cutOff === 1 ? 'was' : 'were'} cut off mid-turn`;
    return `${back} came back after the restart${were}${count === 0 ? '' : ` · ${count} stayed stopped`}`;
  }
  const busy = working(stopped).length;
  const shells = stopped.shells.length;
  const head = `${count} ${count === 1 ? 'session' : 'sessions'} stopped when your ${mac ? 'Mac' : 'computer'} restarted`;
  const were = `${busy === 0 ? 'none was' : busy === 1 ? '1 was' : `${busy} were`} working`;
  return `${head} · ${were}${shells === 0 ? '' : `, ${shells} ${shells === 1 ? 'shell' : 'shells'}`}`;
}

/**
 * Whether the banner shows: some session it is about (`restartIds`) is not one the user dismissed it for. Agents that
 * all came back with nothing cut off show none.
 */
export function restartBannerShown(ids: readonly string[], dismissed: readonly string[]): boolean {
  return ids.some((id) => !dismissed.includes(id));
}

/**
 * The dismissals still standing: those of sessions the banner is still about. One resumed or told to carry on since is
 * forgotten, so a later restart that stops it again shows the banner.
 */
export function dismissedStill(dismissed: readonly string[], ids: readonly string[]): string[] {
  return dismissed.filter((id) => ids.includes(id));
}

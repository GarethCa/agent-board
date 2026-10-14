// The sessions a restart stopped (the daemon or the machine went away under them), which the board offers to resume.
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

/** The banner's words: "8 sessions stopped when your Mac restarted". */
export function restartMessage(count: number, mac: boolean): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'} stopped when your ${mac ? 'Mac' : 'computer'} restarted`;
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

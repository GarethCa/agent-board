import type { Agent, ExternalSession } from '@agent-board/daemon/protocol';

/** What a delete of the selection would take: board items and connectors, and the session tiles. */
export interface DeleteTargets {
  agents: Agent[];
  /** `live`: some pane's process is still running. */
  shells: { name: string; live: boolean }[];
  externals: ExternalSession[];
  items: number;
  connectors: number;
  /** How many shells still run in each agent's tabs, by session id: ended with it. */
  agentShells?: ReadonlyMap<string, number>;
}

/** Whether an external session has ended (its hooks said `done`); it is forgotten rather than just taken off the board. */
export const externalEnded = (session: Pick<ExternalSession, 'state'>) => session.state === 'done';

/**
 * Whether deleting these asks first, as one combined question. Items alone are undoable; a lone session asks, if it
 * needs to, on its own (its tile's delete); anything more, with a session in it, is confirmed together.
 */
export function needsConfirmation(targets: DeleteTargets): boolean {
  const sessions = targets.agents.length + targets.shells.length + targets.externals.length;
  return sessions > 0 && sessions + targets.items + targets.connectors > 1;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What happens to an agent: its session ended if live, its worktree and branch removed if it owns them, and the
 * `liveShells` still running in its window's tabs ended with it.
 */
export function agentLine(agent: Agent, liveShells = 0): string {
  const live = agent.endedAt === null;
  const shells = liveShells === 0 ? '' : ` Its ${liveShells === 1 ? 'shell ends' : `${liveShells} shells end`} with it.`;
  if (agent.ownsWorktree) return `${agent.name}${live ? ' is still running. It is ended, and its' : ': its'} worktree and branch are removed.${shells}`;
  return `${agent.name}${live ? ' is still running. It is ended, and' : ':'} taken off the board; ${agent.cwd} is left as it is.${shells}`;
}

/** What happens to an external session: only taken off the board, never stopped, and back if it starts again. */
export function externalLine(session: ExternalSession): string {
  return externalEnded(session)
    ? `${session.name}: taken off the board. It comes back if it starts again.`
    : `${session.name}: taken off the board. It keeps running elsewhere, and comes back if it starts again.`;
}

/** One line per kind for the combined confirmation, then that sessions can't be undone. */
export function deleteLines(targets: DeleteTargets): string[] {
  const lines: string[] = [];
  if (targets.items > 0) lines.push(`${plural(targets.items, 'board item', 'board items')} deleted (undo brings them back).`);
  if (targets.connectors > 0) lines.push(`${plural(targets.connectors, 'connector', 'connectors')} deleted.`);
  for (const agent of targets.agents) lines.push(agentLine(agent, targets.agentShells?.get(agent.sessionId)));
  for (const shell of targets.shells) lines.push(shell.live ? `${shell.name} still has running shells. They are ended.` : `${shell.name}: removed.`);
  for (const session of targets.externals) lines.push(externalLine(session));
  if (targets.agents.length + targets.shells.length > 0) lines.push("Deleting sessions can't be undone.");
  return lines;
}

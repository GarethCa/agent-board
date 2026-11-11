import type { Agent, ExternalSession } from '@agent-board/daemon/protocol';

/** What a delete of the selection would take: board items and connectors, the session tiles, and the crews whose cards go. */
export interface DeleteTargets {
  agents: Agent[];
  /** `live`: some pane's process is still running. */
  shells: { name: string; live: boolean }[];
  externals: ExternalSession[];
  /** The board items but the cards of running crews, which `crews` has. */
  items: number;
  connectors: number;
  /** What each running crew whose card is selected was asked: its crew is stopped before its card goes. */
  crews?: string[];
  /** How many shells still run in each agent's tabs, by session id: ended with it. */
  agentShells?: ReadonlyMap<string, number>;
}

/**
 * A delete waiting for the user to confirm it: of a live agent, or one that would lose work; of a shell tile with live
 * panes; of an external session still running; of a running crew's card, whose crew stops first; or of a selection of
 * several things at once. Asked one at a time, in order: an agent that turns out to hold unsaved work while a selection
 * is deleted asks again after the rest.
 */
export interface PendingDelete {
  /** What it is about, where two questions can read the same (two crews asked the same thing): one question waits for each key. */
  key?: string;
  title: string;
  lines: string[];
  confirm: string;
  /** Offered beside `confirm` where an agent's worktree and branch could be kept: runs with `keep`. */
  keepLabel?: string;
  /** An unticked box under the lines (deleting a managed clone with its zone): `run` has whether it was ticked. */
  cloneLabel?: string;
  run(keep: boolean, deleteClone: boolean): void;
}

/** Whether `ask` is a question already waiting as `known`: the same key where either has one, else the same words. */
export const sameDelete = (known: PendingDelete, ask: PendingDelete) =>
  known.key !== undefined || ask.key !== undefined ? known.key === ask.key : known.title === ask.title && known.lines.join() === ask.lines.join();

/** Whether an external session has ended (its hooks said `done`); it is forgotten rather than just taken off the board. */
export const externalEnded = (session: Pick<ExternalSession, 'state'>) => session.state === 'done';

/**
 * Whether deleting these asks first, as one combined question. Items alone are undoable; a lone session asks, if it
 * needs to, on its own (its tile's delete), and so does a lone running crew's card; anything more, with a session or
 * such a card in it, is confirmed together.
 */
export function needsConfirmation(targets: DeleteTargets): boolean {
  const asked = targets.agents.length + targets.shells.length + targets.externals.length + (targets.crews?.length ?? 0);
  return asked > 0 && asked + targets.items + targets.connectors > 1;
}

/** What stopping a crew does, as every question that stops one says it. */
export const CREW_STOP_LINE = 'No more reviewers start, and no reviews go back. Its agents stay as they are. A stopped crew can’t be started again.';

/** What happens to a running crew whose card is deleted with other things: it is stopped first, and only then its card goes. */
const crewLine = (asked: string) => `The crew asked “${asked}” is stopped, and its card taken off the board. It can’t be started again.`;

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

/** One line per kind, and per session and running crew, for the combined confirmation, then that sessions can't be undone. */
export function deleteLines(targets: DeleteTargets): string[] {
  const lines: string[] = [];
  if (targets.items > 0) lines.push(`${plural(targets.items, 'board item', 'board items')} deleted (undo brings them back).`);
  if (targets.connectors > 0) lines.push(`${plural(targets.connectors, 'connector', 'connectors')} deleted.`);
  for (const agent of targets.agents) lines.push(agentLine(agent, targets.agentShells?.get(agent.sessionId)));
  for (const shell of targets.shells) lines.push(shell.live ? `${shell.name} still has running shells. They are ended.` : `${shell.name}: removed.`);
  for (const session of targets.externals) lines.push(externalLine(session));
  for (const asked of targets.crews ?? []) lines.push(crewLine(asked));
  if (targets.agents.length + targets.shells.length > 0) lines.push("Deleting sessions can't be undone.");
  return lines;
}

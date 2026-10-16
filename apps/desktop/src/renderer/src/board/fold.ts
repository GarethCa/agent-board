// Which closed agents the user unfolded from their chip. A closed agent (see `isClosed`) is drawn as a chip unless its
// node id is here, so the fold is the default and only the exceptions are saved. Pure, so every rule is unit-tested; the
// board holds the list in one state, saved in the daemon's view state, which the daemon reads too.
import { isClosed, unfoldedFrom } from '@agent-board/daemon/board-layout';
import type { Agent } from '@agent-board/daemon/protocol';
import { tileNodeId } from './tiles';

/** The node ids of the closed agents drawn as full tiles because the user unfolded them. */
export type Unfolded = readonly string[];

export { unfoldedFrom };

type Closable = Pick<Agent, 'sessionId' | 'endedAt' | 'state' | 'shellSessionId' | 'shellHarness'>;

/**
 * `unfolded` with the tile `id` in it (open) or out of it (a chip again, when its agent is closed). An agent that isn't
 * closed is never put in, so an undo can't leave a live agent's entry behind to keep it from folding when it next ends.
 */
export function withUnfolded(unfolded: Unfolded, id: string, open: boolean, agents: readonly Closable[]): Unfolded {
  const closed = agents.some((agent) => tileNodeId('agent', agent.sessionId) === id && isClosed(agent));
  const wanted = open && closed;
  if (unfolded.includes(id) === wanted) return unfolded;
  return wanted ? [...unfolded, id] : unfolded.filter((known) => known !== id);
}

/**
 * Only the entries of agents still closed: one restarted, or deleted, forgets it, so it folds again the next time it
 * ends.
 */
export function keepUnfolded(unfolded: Unfolded, agents: readonly Closable[]): Unfolded {
  const closed = new Set(agents.filter(isClosed).map((agent) => tileNodeId('agent', agent.sessionId)));
  return unfolded.every((id) => closed.has(id)) ? unfolded : unfolded.filter((id) => closed.has(id));
}

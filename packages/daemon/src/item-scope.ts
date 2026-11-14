// Who reads a board item agents read and write through its own methods (a steps card): where it sits. In a zone it is
// that zone's agents'; loose, every agent's; and always the agents it is about. It is the item's audience, as its
// card's chip says, not a limit on which agents an agent may act on.
import type { Agent, BoardItem } from './protocol.ts';

/** Whether `agent` reads `item`: loose, in its zone, or one it is part of (`involved`). */
export function readsItem(agent: Agent, item: Pick<BoardItem, 'zoneId'>, involved: boolean): boolean {
  return item.zoneId === null || item.zoneId === agent.zoneId || involved;
}

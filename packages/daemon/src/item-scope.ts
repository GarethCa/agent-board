// Who reads a board item agents read and write through its own methods (a steps card): where it sits. On a ticket's
// own board it is that ticket's agents' (its chat and its helpers); in a zone, that zone's agents'; loose, every agent's;
// and always the agents it is about. It is the item's audience, as its card's chip says, not a limit on which agents an
// agent may act on.
import type { Agent, BoardItem } from './protocol.ts';

/** Whether `agent` is one of the ticket's agents: the chat whose session is `ticket`, or a helper in it. */
function onTicket(agent: Pick<Agent, 'sessionId' | 'ticket'>, ticket: string): boolean {
  return agent.sessionId === ticket || agent.ticket === ticket;
}

/** Whether `agent` reads `item`: on a ticket's board it is on, loose, in its zone, or one it is part of (`involved`). */
export function readsItem(agent: Agent, item: Pick<BoardItem, 'zoneId' | 'ticket'>, involved: boolean): boolean {
  if (involved) return true;
  if (typeof item.ticket === 'string') return onTicket(agent, item.ticket);
  return item.zoneId === null || item.zoneId === agent.zoneId;
}

/** Why an agent doesn't read `item`, `what` naming it ("that memory"), when `readsItem` says it doesn't. */
export function notReadBecause(what: string, item: Pick<BoardItem, 'ticket'>): string {
  return typeof item.ticket === 'string' ? `${what} is on a ticket's board you are not on` : `${what} is in a zone you are not in`;
}
